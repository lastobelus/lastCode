import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import { PromptSnippetsError, PromptSnippetsState, type PromptSnippet } from "@t3tools/contracts";
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
const Stored = Schema.Struct({
  ...PromptSnippetsState.fields,
  lastAttemptAt: Schema.NullOr(Schema.String),
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

export function consolidate(
  snippets: readonly PromptSnippet[],
  proposals: readonly Proposal[],
  newId: () => string,
): readonly PromptSnippet[] {
  if (
    proposals.length > 40 ||
    (snippets.length === 0 && (proposals.length < 8 || proposals.length > 10))
  )
    throw new Error("Invalid proposal count");
  const claimed = new Set<string>();
  const replacements: PromptSnippet[] = [];
  for (const proposal of proposals) {
    const title = proposal.title.trim();
    const text = proposal.text.trim();
    if (!title || title.length > 100 || !text || text.length > 4000)
      throw new Error("Invalid snippet length");
    const previous = proposal.existingIds.map((id) => {
      const found = snippets.find((snippet) => snippet.id === id);
      if (!found || claimed.has(id)) throw new Error("Invalid existing ID");
      claimed.add(id);
      return found;
    });
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
  }
  const result = [...snippets.filter((snippet) => !claimed.has(snippet.id)), ...replacements];
  if (result.length > 100 || new Set(result.map((snippet) => snippet.text)).size !== result.length)
    throw new Error("Invalid library");
  return result;
}

export class PromptSnippets extends Context.Service<
  PromptSnippets,
  {
    readonly list: Effect.Effect<PromptSnippetsState>;
    readonly recordUse: (input: {
      snippetId: string;
      query: string;
    }) => Effect.Effect<void, PromptSnippetsError>;
    readonly discover: () => Effect.Effect<PromptSnippetsState, PromptSnippetsError>;
    readonly discoverIfDue: Effect.Effect<void, PromptSnippetsError>;
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
    lastDiscoveryAt: null,
    lastAttemptAt: null,
    discovering: false,
    lastError: null,
  };
  let state = initial;
  if (yield* fs.exists(filename))
    state = yield* fs.readFileString(filename).pipe(
      Effect.flatMap(decodeStored),
      Effect.mapError((cause) => new PromptSnippetsError({ operation: "load", cause })),
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
          yield* mutation.withPermits(1)(save({ ...state, lastAttemptAt: now, lastError: null }));
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
            })
            .pipe(Effect.timeout("3 minutes"));
          yield* mutation.withPermits(1)(
            Effect.gen(function* () {
              const ids = yield* Effect.forEach(output.snippets, () => crypto.randomUUIDv4());
              let index = 0;
              const snippets = yield* Effect.try(() =>
                consolidate(state.snippets, output.snippets, () => ids[index++]!),
              );
              yield* save({ ...state, snippets, lastDiscoveryAt: now, lastError: null });
            }),
          );
          return yield* list;
        });
        return yield* run.pipe(
          Effect.catch(() =>
            mutation
              .withPermits(1)(
                save({
                  ...state,
                  lastError: "Couldn't find new prompts. Your saved prompts are unchanged.",
                }),
              )
              .pipe(Effect.andThen(list)),
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
      Effect.catch(() => Effect.logWarning("Prompt discovery worker failed")),
      Effect.andThen(Effect.sleep("24 hours")),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
