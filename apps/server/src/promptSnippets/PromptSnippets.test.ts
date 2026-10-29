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
        yield* service.discoverIfDue;
        const first = yield* service.list;
        expect(first.snippets).toHaveLength(8);
        const id = first.snippets[0]!.id;
        yield* service.recordUse({ snippetId: id, query: " Review " });
        yield* service.discoverIfDue;
        expect(calls).toBe(1);
        yield* TestClock.adjust("23 hours");
        yield* service.discoverIfDue;
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
