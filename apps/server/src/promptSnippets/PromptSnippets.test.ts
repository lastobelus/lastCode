import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  TextGenerationError,
  type PromptSnippet,
} from "@t3tools/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as PromptSnippets from "./PromptSnippets.ts";
const proposals = Array.from({ length: 8 }, (_, i) => ({
  existingIds: [] as string[],
  title: `Task ${i}`,
  text: `Review synthetic module ${i}; do not merge.`,
}));
const human = (text: string) => ({
  payload_json: JSON.stringify({ role: "user", createdBy: "user", text }),
});
it.effect("runs daily discovery for installed builds and skips development and test runtimes", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    for (const { nodeEnv, devUrl, expected } of [
      { nodeEnv: "production", devUrl: undefined, expected: 2 },
      { nodeEnv: "production", devUrl: new URL("http://localhost:3000"), expected: 0 },
      { nodeEnv: "test", devUrl: undefined, expected: 0 },
    ]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          yield* Layer.build(
            PromptSnippets.worker.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ServerConfig.ServerConfig, { ...config, devUrl }),
                  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NODE_ENV: nodeEnv } })),
                  Layer.mock(PromptSnippets.PromptSnippets)({
                    discoverIfDue: Effect.sync(() => calls++).pipe(Effect.as(24 * 60 * 60 * 1000)),
                  }),
                ),
              ),
            ),
          );
          yield* TestClock.adjust(0);
          expect(calls).toBe(expected === 0 ? 0 : 1);
          yield* TestClock.adjust("24 hours");
          expect(calls).toBe(expected);
        }),
      );
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "prompt-snippets-worker-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
it("preserves repeated human messages as frequency evidence and excludes agent/system messages", () => {
  expect(
    PromptSnippets.selectCorpus([
      human("Review; do not merge."),
      ...["agent", "system"].map((createdBy) => ({
        payload_json: JSON.stringify({ role: "user", createdBy, text: "Excluded" }),
      })),
      { payload_json: JSON.stringify({ role: "assistant", createdBy: "user", text: "Excluded" }) },
      human("x".repeat(4001)),
      human("Review; do not merge."),
    ]),
  ).toEqual(["Review; do not merge.", "Review; do not merge."]);
});
it("preserves IDs and query preferences across updates and consolidation", () => {
  const snippet: PromptSnippet = {
    id: "stable",
    title: "Review",
    text: "Review; do not merge.",
    useCount: 3,
    lastUsedAt: null,
    queryUses: [{ query: "review", count: 3 }],
  };
  const result = PromptSnippets.consolidate(
    [snippet],
    [{ existingIds: ["stable"], title: "Scoped review", text: "Review carefully; do not merge." }],
    () => "new",
  );
  expect(result[0]).toEqual({
    ...snippet,
    title: "Scoped review",
    text: "Review carefully; do not merge.",
  });
  expect(
    PromptSnippets.consolidate(
      [snippet, { ...snippet, id: "variant", useCount: 2 }],
      [{ existingIds: ["stable", "variant"], title: "Review", text: snippet.text }],
      () => "new",
    )[0],
  ).toMatchObject({ id: "stable", useCount: 5, queryUses: [{ query: "review", count: 6 }] });
  expect(() =>
    PromptSnippets.consolidate(
      [snippet],
      [{ existingIds: ["invented"], title: "Review", text: "Review" }],
      () => "new",
    ),
  ).toThrow();
});
it.effect(
  "discovers daily and retains persisted choices after invalid output and provider failure",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      let failure = 0;
      const generation = Layer.mock(TextGeneration.TextGeneration)({
        generatePromptSnippets: (input) => {
          calls++;
          expect(input.modelSelection).toEqual(
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
          );
          expect(input.messages).toEqual(["Review; do not merge."]);
          return failure === 2
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generatePromptSnippets",
                  detail: "Synthetic failure",
                }),
              )
            : Effect.succeed({
                snippets:
                  failure === 1
                    ? [{ existingIds: ["invented"], title: "Bad", text: "Bad" }]
                    : proposals,
              });
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('synthetic-message', 'synthetic-thread', 'user', 0, '2026-01-01', '2026-01-01', ${human("Review; do not merge.").payload_json})`;
      const retained = yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        expect(yield* service.discoverIfDue).toBe(24 * 60 * 60 * 1000);
        const first = yield* service.list;
        expect(first.snippets).toHaveLength(8);
        const id = first.snippets[0]!.id;
        yield* service.recordUse({ snippetId: id, query: " Review " });
        yield* service.discoverIfDue;
        expect(calls).toBe(1);
        yield* TestClock.adjust("23 hours");
        expect(yield* service.discoverIfDue).toBe(60 * 60 * 1000);
        expect(calls).toBe(1);
        yield* TestClock.adjust("1 hour");
        failure = 1;
        yield* service.discoverIfDue;
        const invalid = yield* service.list;
        expect(invalid.snippets[0]).toMatchObject({
          id,
          useCount: 1,
          queryUses: [{ query: "review", count: 1 }],
        });
        expect(invalid.lastError).not.toBeNull();
        expect(invalid.lastDiscoveryAt).toBe(first.lastDiscoveryAt);
        failure = 2;
        yield* service.discover();
        expect((yield* service.list).snippets).toEqual(invalid.snippets);
        expect((yield* service.list).discovering).toBe(false);
        return invalid.snippets;
      }).pipe(Effect.provide(PromptSnippets.layer.pipe(Layer.provide(generation))));
      const reloaded = yield* Effect.gen(function* () {
        return yield* (yield* PromptSnippets.PromptSnippets).list;
      }).pipe(Effect.provide(PromptSnippets.layer.pipe(Layer.provide(generation))));
      expect(reloaded.snippets).toEqual(retained);
      yield* TestClock.adjust("2 hours");
      const remaining = yield* Effect.gen(function* () {
        return yield* (yield* PromptSnippets.PromptSnippets).discoverIfDue;
      }).pipe(Effect.provide(PromptSnippets.layer.pipe(Layer.provide(generation))));
      expect(remaining).toBe(22 * 60 * 60 * 1000);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Settings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          SqlitePersistence.layerMemory,
          ServerConfig.layerTest(process.cwd(), { prefix: "prompt-snippets-test-" }),
        ).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
      ),
    ),
);

it("keeps valid updates when proposals repeat existing text or exceed the library limit", () => {
  const snippets: PromptSnippet[] = Array.from({ length: 100 }, (_, index) => ({
    id: `saved-${index}`,
    title: `Saved ${index}`,
    text: `Review module ${index}; do not merge.`,
    useCount: index,
    lastUsedAt: null,
    queryUses: [{ query: "review", count: index }],
  }));
  const result = PromptSnippets.consolidate(
    snippets,
    [
      { existingIds: [], title: "Duplicate", text: snippets[0]!.text },
      { existingIds: [], title: "Over limit", text: "A new instruction." },
      {
        existingIds: ["saved-1"],
        title: "Careful review",
        text: "Review module 1 carefully; do not merge.",
      },
    ],
    () => "new",
  );
  expect(result).toHaveLength(100);
  expect(result.find((snippet) => snippet.id === "saved-0")).toEqual(snippets[0]);
  expect(result.find((snippet) => snippet.id === "saved-1")).toEqual({
    ...snippets[1],
    title: "Careful review",
    text: "Review module 1 carefully; do not merge.",
  });
});

it.effect.each(["corrupt", "unreadable", "unmovable"] as const)(
  "starts with an actionable warning and preserves the %s optional library",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const filename = `${config.stateDir}/prompt-snippets.json`;
      const original = "{synthetic-broken-library";
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(filename, original);
      const fileSystem =
        kind === "unmovable"
          ? {
              ...fs,
              rename: (from: string, _to: string) => fs.rename(from, `${from}.missing/recovery`),
            }
          : kind === "unreadable"
            ? {
                ...fs,
                readFileString: (path: string) =>
                  fs.readFileString(path === filename ? `${filename}.missing` : path),
              }
            : fs;
      const serviceState = yield* Effect.gen(function* () {
        return yield* (yield* PromptSnippets.PromptSnippets).list;
      }).pipe(
        Effect.provide(PromptSnippets.layer),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      expect(serviceState.snippets).toEqual([]);
      expect(serviceState.lastError).toContain("saved prompts");
      const backups = (yield* fs.readDirectory(config.stateDir)).filter((name) =>
        name.startsWith("prompt-snippets.json.recovery-"),
      );
      expect(backups).toHaveLength(kind === "unmovable" ? 0 : 1);
      expect(
        yield* fs.readFileString(
          kind === "unmovable" ? filename : `${config.stateDir}/${backups[0]}`,
        ),
      ).toBe(original);
      if (kind === "unmovable") expect(serviceState.lastError).toContain("prompt-snippets.json");
    }).pipe(Effect.provide(testDependencies())),
);

function testDependencies() {
  return Layer.mergeAll(
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    SqlitePersistence.layerMemory,
    ServerConfig.layerTest(process.cwd(), { prefix: "prompt-snippets-review-test-" }),
  ).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)));
}

const savedSnippet: PromptSnippet = {
  id: "saved",
  title: "Review",
  text: "Review this module; do not merge.",
  useCount: 4,
  lastUsedAt: null,
  queryUses: [{ query: "review", count: 4 }],
};
const fixtureJson = (
  snippets: readonly PromptSnippet[],
  dismissed: readonly PromptSnippet[] = [],
) =>
  JSON.stringify({
    snippets,
    dismissed,
    discovering: false,
    lastError: null,
    lastAttemptAt: null,
    lastDiscoveryAt: null,
  });
const seedLibrary = Effect.fn("test.seedPromptLibrary")(function* (
  snippets: readonly PromptSnippet[],
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  yield* fs.writeFileString(`${config.stateDir}/prompt-snippets.json`, fixtureJson(snippets));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('synthetic-message', 'synthetic-thread', 'user', 0, '2026-01-01', '2026-01-01', ${human("Review; do not merge.").payload_json})`;
});

it.effect("retains a concurrent chosen query when discovery queues behind its in-flight save", () =>
  Effect.gen(function* () {
    yield* seedLibrary([savedSnippet]);
    const fs = yield* FileSystem.FileSystem;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hold = true;
    const fileSystem: FileSystem.FileSystem = {
      ...fs,
      writeFileString: (...args) =>
        Effect.gen(function* () {
          if (hold) {
            hold = false;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return yield* fs.writeFileString(...args);
        }),
    };
    yield* Effect.gen(function* () {
      const service = yield* PromptSnippets.PromptSnippets;
      const use = yield* service
        .recordUse({ snippetId: savedSnippet.id, query: "scoped" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      const discovery = yield* service
        .discover()
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(use);
      yield* Fiber.join(discovery);
      expect((yield* service.list).snippets[0]).toMatchObject({
        id: savedSnippet.id,
        useCount: 5,
        queryUses: [
          { query: "review", count: 4 },
          { query: "scoped", count: 1 },
        ],
      });
    }).pipe(
      Effect.provide(
        PromptSnippets.layer.pipe(
          Layer.provide(
            Layer.mock(TextGeneration.TextGeneration)({
              generatePromptSnippets: () => Effect.succeed({ snippets: [] }),
            }),
          ),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  }).pipe(Effect.provide(testDependencies())),
);

it.effect(
  "persists dismissals, includes them in mining input, and filters normalized repeats without dropping valid updates",
  () =>
    Effect.gen(function* () {
      const kept = { ...savedSnippet, id: "kept", text: "Review the server only; do not merge." };
      yield* seedLibrary([savedSnippet, kept]);
      let restored = false;
      const generation = Layer.mock(TextGeneration.TextGeneration)({
        generatePromptSnippets: (input) => {
          expect(input.dismissed).toEqual(
            restored
              ? []
              : [{ id: savedSnippet.id, title: savedSnippet.title, text: savedSnippet.text }],
          );
          if (restored) {
            expect(input.existing).toContainEqual({
              id: savedSnippet.id,
              title: savedSnippet.title,
              text: savedSnippet.text,
            });
            return Effect.succeed({ snippets: [] });
          }
          return Effect.succeed({
            snippets: [
              {
                existingIds: [],
                title: "Dismissed again",
                text: "  REVIEW this  module; do not merge.\n",
              },
              { existingIds: [kept.id], title: "Scoped review", text: kept.text },
              {
                existingIds: [],
                title: "New",
                text: "Inspect synthetic tests; do not change production code.",
              },
            ],
          });
        },
      });
      const serviceLayer = PromptSnippets.layer.pipe(Layer.provide(generation));
      yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        yield* service.dismiss({ snippetId: savedSnippet.id });
        yield* service.dismiss({ snippetId: savedSnippet.id });
        expect((yield* service.list).snippets).toEqual([kept]);
        expect(
          yield* service
            .recordUse({ snippetId: savedSnippet.id, query: "review" })
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "recordUse" });
      }).pipe(Effect.provide(serviceLayer));
      yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        expect((yield* service.list).snippets).toEqual([kept]);
        const result = yield* service.discover();
        expect(result.lastError).toBeNull();
        expect(result.snippets).toHaveLength(2);
        expect(result.snippets.find((entry) => entry.id === kept.id)).toEqual({
          ...kept,
          title: "Scoped review",
        });
        expect(result.snippets.some((entry) => entry.text.includes("REVIEW this"))).toBe(false);
        yield* service.restore({ snippetId: savedSnippet.id });
        yield* service.restore({ snippetId: savedSnippet.id });
        expect(
          (yield* service.list).snippets.find((entry) => entry.id === savedSnippet.id),
        ).toEqual(savedSnippet);
        restored = true;
      }).pipe(Effect.provide(serviceLayer));
      yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        expect(
          (yield* service.list).snippets.find((entry) => entry.id === savedSnippet.id),
        ).toEqual(savedSnippet);
        expect((yield* service.discover()).lastError).toBeNull();
        expect(
          (yield* service.list).snippets.find((entry) => entry.id === savedSnippet.id),
        ).toEqual(savedSnippet);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(testDependencies())),
);

it.effect(
  "explains unsupported configured title models without exposing source messages or changing the library",
  () =>
    Effect.gen(function* () {
      yield* seedLibrary([savedSnippet]);
      yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        const result = yield* service.discover();
        expect(result.snippets).toEqual([savedSnippet]);
        expect(result.lastError).toMatch(/text.?generation model/i);
        expect(result.lastError).toContain("Settings");
        expect(result.lastError).not.toContain("Review; do not merge.");
      }).pipe(
        Effect.provide(
          PromptSnippets.layer.pipe(
            Layer.provide(
              Layer.mock(TextGeneration.TextGeneration)({
                generatePromptSnippets: () =>
                  Effect.fail(
                    new TextGenerationError({
                      operation: "generatePromptSnippets",
                      reason: "prompt-mining-unsupported",
                      detail: "Synthetic internal error",
                    }),
                  ),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(testDependencies())),
);

it.effect(
  "retains a concurrent chosen query when the discovery failure save queues behind it",
  () =>
    Effect.gen(function* () {
      yield* seedLibrary([savedSnippet]);
      const fs = yield* FileSystem.FileSystem;
      const mining = yield* Deferred.make<void>();
      const fail = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      const savingUse = yield* Deferred.make<void>();
      const releaseUse = yield* Deferred.make<void>();
      let hold = true;
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (...args) =>
          Effect.gen(function* () {
            if (hold && args[1].includes('"useCount":5')) {
              hold = false;
              yield* Deferred.succeed(savingUse, undefined);
              yield* Deferred.await(releaseUse);
            }
            return yield* fs.writeFileString(...args);
          }),
      };
      const generation = Layer.mock(TextGeneration.TextGeneration)({
        generatePromptSnippets: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(mining, undefined);
            yield* Deferred.await(fail);
            return yield* new TextGenerationError({
              operation: "generatePromptSnippets",
              detail: "Synthetic provider failure",
            });
          }).pipe(Effect.tapError(() => Deferred.succeed(failed, undefined))),
      });
      yield* Effect.gen(function* () {
        const service = yield* PromptSnippets.PromptSnippets;
        const discover = yield* service
          .discover()
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(mining);
        const use = yield* service
          .recordUse({ snippetId: savedSnippet.id, query: "scoped" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(savingUse);
        yield* Deferred.succeed(fail, undefined);
        yield* Deferred.await(failed);
        yield* Deferred.succeed(releaseUse, undefined);
        yield* Fiber.join(use);
        yield* Fiber.join(discover);
        const state = yield* service.list;
        expect(state.snippets[0]).toMatchObject({
          id: savedSnippet.id,
          useCount: 5,
          queryUses: [
            { query: "review", count: 4 },
            { query: "scoped", count: 1 },
          ],
        });
        expect(state.lastError).toBe(
          "Couldn't find new prompts. Your saved prompts are unchanged.",
        );
      }).pipe(
        Effect.provide(PromptSnippets.layer.pipe(Layer.provide(generation))),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
    }).pipe(Effect.provide(testDependencies())),
);

it.effect("preserves the full library and dismissal when restore has no free slot", () =>
  Effect.gen(function* () {
    const full = Array.from({ length: 100 }, (_, index) => ({
      ...savedSnippet,
      id: `full-${index}`,
      text: `Review synthetic module ${index}; do not merge.`,
    }));
    yield* seedLibrary(full);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const filename = `${config.stateDir}/prompt-snippets.json`;
    yield* fs.writeFileString(filename, fixtureJson(full, [savedSnippet]));
    yield* Effect.gen(function* () {
      const service = yield* PromptSnippets.PromptSnippets;
      const before = yield* fs.readFileString(filename);
      yield* service.restore({ snippetId: full[0]!.id });
      expect(
        yield* service.restore({ snippetId: savedSnippet.id }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PromptSnippetsError", operation: "restore" });
      expect(yield* fs.readFileString(filename)).toBe(before);
      expect((yield* service.list).snippets).toEqual(full);
      yield* service.dismiss({ snippetId: full[0]!.id });
      yield* service.restore({ snippetId: savedSnippet.id });
      expect((yield* service.list).snippets).toHaveLength(100);
      expect((yield* service.list).snippets.find((entry) => entry.id === savedSnippet.id)).toEqual(
        savedSnippet,
      );
    }).pipe(Effect.provide(PromptSnippets.layer));
  }).pipe(Effect.provide(testDependencies())),
);
