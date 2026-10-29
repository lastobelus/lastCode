import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  PromptSnippetsError,
  PromptSnippetsState,
  TextGenerationError,
  PromptSnippet,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const DAY = 24 * 60 * 60 * 1000;
const isTextGenerationError = Schema.is(TextGenerationError);
const Stored = Schema.Struct({
  ...PromptSnippetsState.fields,
  lastAttemptAt: Schema.NullOr(Schema.String),
  dismissed: Schema.Array(PromptSnippet).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Stored));
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Stored));
type State = typeof Stored.Type;
type Proposal = {
  readonly existingIds: readonly string[];
  readonly title: string;
  readonly text: string;
};
export function discoveryDue(lastAttemptAt: string | null, now: number): boolean {
  return lastAttemptAt === null || now - Date.parse(lastAttemptAt) >= DAY;
}

export function selectCorpus(rows: readonly { payload_json: string }[]): string[] {
  const texts: string[] = [];
  let size = 0;
  for (const row of rows) {
    const message = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (
      message.role !== "user" ||
      message.createdBy !== "user" ||
      message.senderThreadId ||
      message.scheduledTaskId ||
      message.workflowScript
    )
      continue;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    // Skip oversized messages rather than stripping a qualifier from their tail.
    if (!text || text.length > 4000) continue;
    if (size + text.length > 60_000) break;
    texts.push(text);
    size += text.length;
  }
  return texts;
}

const normalizedText = (text: string) =>
  text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export function consolidate(
  snippets: readonly PromptSnippet[],
  proposals: readonly Proposal[],
  newId: () => string,
  dismissed: readonly PromptSnippet[] = [],
): readonly PromptSnippet[] {
  if (
    proposals.length > 40 ||
    (snippets.length === 0 &&
      dismissed.length === 0 &&
      (proposals.length < 8 || proposals.length > 10))
  )
    throw new Error("Invalid proposal count");
  const claimed = new Set<string>();
  const mentioned = new Set<string>();
  const dismissedTexts = new Set(dismissed.map((snippet) => normalizedText(snippet.text)));
  const dismissedIds = new Set(dismissed.map((snippet) => snippet.id));
  const replacements: PromptSnippet[] = [];
  let size = snippets.length;
  for (const proposal of proposals) {
    const title = proposal.title.trim();
    const text = proposal.text.trim();
    if (!title || title.length > 100 || !text || text.length > 4000)
      throw new Error("Invalid snippet length");
    if (
      dismissedTexts.has(normalizedText(text)) ||
      proposal.existingIds.some((id) => dismissedIds.has(id))
    )
      continue;
    const previous = proposal.existingIds.map((id) => {
      const found = snippets.find((snippet) => snippet.id === id);
      if (!found || mentioned.has(id)) throw new Error("Invalid existing ID");
      mentioned.add(id);
      return found;
    });
    // Ignore a duplicate proposal without replacing either saved entry or its usage history.
    if (
      replacements.some((snippet) => normalizedText(snippet.text) === normalizedText(text)) ||
      snippets.some(
        (snippet) =>
          !claimed.has(snippet.id) &&
          !proposal.existingIds.includes(snippet.id) &&
          normalizedText(snippet.text) === normalizedText(text),
      )
    )
      continue;
    if (previous.length === 0 && size >= 100) continue;
    for (const snippet of previous) claimed.add(snippet.id);
    const queries = new Map<string, number>();
    for (const snippet of previous)
      for (const usage of snippet.queryUses)
        queries.set(usage.query, (queries.get(usage.query) ?? 0) + usage.count);
    const dates = previous
      .flatMap((snippet) => (snippet.lastUsedAt === null ? [] : [snippet.lastUsedAt]))
      .sort();
    replacements.push({
      id: previous[0]?.id ?? newId(),
      title,
      text,
      useCount: previous.reduce((count, snippet) => count + snippet.useCount, 0),
      lastUsedAt: dates.at(-1) ?? null,
      queryUses: [...queries].map(([query, count]) => ({ query, count })),
    });
    size += 1 - previous.length;
  }
  return [...snippets.filter((snippet) => !claimed.has(snippet.id)), ...replacements];
}

export class PromptSnippets extends Context.Service<
  PromptSnippets,
  {
    readonly list: Effect.Effect<PromptSnippetsState>;
    readonly recordUse: (input: {
      snippetId: string;
      query: string;
    }) => Effect.Effect<void, PromptSnippetsError>;
    readonly dismiss: (input: { snippetId: string }) => Effect.Effect<void, PromptSnippetsError>;
    readonly discover: () => Effect.Effect<PromptSnippetsState, PromptSnippetsError>;
    readonly discoverIfDue: Effect.Effect<number, PromptSnippetsError>;
  }
>()("t3/promptSnippets/PromptSnippets") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const generation = yield* TextGeneration.TextGeneration;
  const filename = path.join(config.stateDir, "prompt-snippets.json");
  const mutation = yield* Semaphore.make(1);
  const discovery = yield* Semaphore.make(1);
  const initial: State = {
    snippets: [],
    dismissed: [],
    lastDiscoveryAt: null,
    lastAttemptAt: null,
    discovering: false,
    lastError: null,
  };
  let state = initial;
  let preserveUnreadable = false;
  state = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(filename))) return initial;
    return yield* fs.readFileString(filename).pipe(Effect.flatMap(decodeStored));
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Could not load saved common prompts", { cause });
        // Preserve the source before a later explicit discovery can replace the library.
        preserveUnreadable = true;
        const backup = yield* crypto.randomUUIDv4();
        yield* fs.rename(filename, `${filename}.recovery-${backup}`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              preserveUnreadable = false;
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Could not preserve unreadable common prompts", { cause }),
          ),
        );
        return {
          ...initial,
          lastError: preserveUnreadable
            ? "Couldn't read your saved prompts or make a recovery copy, so the list is empty and new prompts can't be saved yet. Check access to prompt-snippets.json and its folder, then choose Find new prompts."
            : "Couldn't read your saved prompts, so the list is empty for now. Your old prompts file was kept as a recovery copy. Choose Find new prompts to rebuild the list.",
        };
      }),
    ),
  );
  let discovering = false;
  const list = Effect.sync(() => ({
    snippets: state.snippets,
    lastDiscoveryAt: state.lastDiscoveryAt,
    discovering,
    lastError: state.lastError,
  }));
  const save = Effect.fn("PromptSnippets.save")(
    function* (next: State) {
      if (preserveUnreadable) {
        const backup = yield* crypto.randomUUIDv4();
        yield* fs.rename(filename, `${filename}.recovery-${backup}`);
        preserveUnreadable = false;
      }
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(`${filename}.tmp`, yield* encodeStored(next), { mode: 0o600 });
      yield* fs.rename(`${filename}.tmp`, filename);
      state = next;
    },
    Effect.mapError((cause) => new PromptSnippetsError({ operation: "persist", cause })),
  );
  const discover = Effect.fn("PromptSnippets.discover")(function* () {
    if (discovering) return yield* list;
    return yield* discovery.withPermits(1)(
      Effect.gen(function* () {
        discovering = true;
        const now = DateTime.formatIso(yield* DateTime.now);
        const run = Effect.gen(function* () {
          yield* mutation.withPermits(1)(
            Effect.suspend(() => save({ ...state, lastAttemptAt: now, lastError: null })),
          );
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user' ORDER BY created_at DESC LIMIT 500`;
          const messages = yield* Effect.try(() => selectCorpus(rows));
          if (messages.length === 0) return yield* list;
          const currentSettings = yield* settings.getSettings;
          const output = yield* generation
            .generatePromptSnippets({
              cwd: config.cwd,
              modelSelection: currentSettings.textGenerationModelSelection,
              messages,
              existing: state.snippets.map(({ id, title, text }) => ({ id, title, text })),
              dismissed: state.dismissed.map(({ id, title, text }) => ({ id, title, text })),
            })
            .pipe(Effect.timeout("3 minutes"));
          yield* mutation.withPermits(1)(
            Effect.gen(function* () {
              const ids = yield* Effect.forEach(output.snippets, () => crypto.randomUUIDv4());
              let index = 0;
              const snippets = yield* Effect.try(() =>
                consolidate(state.snippets, output.snippets, () => ids[index++]!, state.dismissed),
              );
              yield* save({ ...state, snippets, lastDiscoveryAt: now, lastError: null });
            }),
          );
          return yield* list;
        });
        return yield* run.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Common prompt discovery failed", { cause }).pipe(
              Effect.andThen(
                mutation
                  .withPermits(1)(
                    Effect.suspend(() =>
                      save({
                        ...state,
                        lastError:
                          isTextGenerationError(cause) &&
                          cause.reason === "prompt-mining-unsupported"
                            ? "Your text generation model can't find common prompts. Choose a model from a different provider in Settings > Text generation."
                            : "Couldn't find new prompts. Your saved prompts are unchanged.",
                      }),
                    ),
                  )
                  .pipe(Effect.andThen(list)),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              discovering = false;
            }),
          ),
          Effect.map((result) => ({ ...result, discovering: false })),
        );
      }),
    );
  });
  return PromptSnippets.of({
    list,
    discover,
    discoverIfDue: Effect.gen(function* () {
      if (discoveryDue(state.lastAttemptAt, yield* Clock.currentTimeMillis)) yield* discover();
      const now = yield* Clock.currentTimeMillis;
      return Math.max(
        1_000,
        DAY - (state.lastAttemptAt === null ? 0 : now - Date.parse(state.lastAttemptAt)),
      );
    }),
    dismiss: Effect.fn("PromptSnippets.dismiss")(function* (input) {
      yield* mutation.withPermits(1)(
        Effect.gen(function* () {
          const snippet = state.snippets.find((snippet) => snippet.id === input.snippetId);
          if (!snippet) {
            if (state.dismissed.some((snippet) => snippet.id === input.snippetId)) return;
            return yield* new PromptSnippetsError({ operation: "dismiss" });
          }
          yield* save({
            ...state,
            snippets: state.snippets.filter((entry) => entry.id !== snippet.id),
            dismissed: [...state.dismissed, snippet],
          });
        }),
      );
    }),
    recordUse: Effect.fn("PromptSnippets.recordUse")(function* (input) {
      yield* mutation.withPermits(1)(
        Effect.gen(function* () {
          if (
            !state.snippets.some((snippet) => snippet.id === input.snippetId) ||
            input.query.length > 500
          )
            return yield* new PromptSnippetsError({ operation: "recordUse" });
          const query = input.query.trim().toLowerCase();
          const now = DateTime.formatIso(yield* DateTime.now);
          const snippets = state.snippets.map((snippet) => {
            if (snippet.id !== input.snippetId) return snippet;
            const queries = new Map(snippet.queryUses.map((usage) => [usage.query, usage.count]));
            if (query) queries.set(query, (queries.get(query) ?? 0) + 1);
            return {
              ...snippet,
              useCount: snippet.useCount + 1,
              lastUsedAt: now,
              queryUses: [...queries]
                .map(([query, count]) => ({ query, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 100),
            };
          });
          yield* save({ ...state, snippets });
        }),
      );
    }),
  });
});
export const layer = Layer.effect(PromptSnippets, make);
export const worker = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Development and test builds mine only on explicit discover calls.
    if (config.devUrl !== undefined || ServerConfig.telemetryChannel === "dev") return;
    const service = yield* PromptSnippets;
    yield* service.discoverIfDue.pipe(
      Effect.catch(() => Effect.logWarning("Prompt discovery worker failed").pipe(Effect.as(DAY))),
      Effect.flatMap((delay) => Effect.sleep(delay)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
