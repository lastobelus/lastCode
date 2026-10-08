import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewRecoveryStorageError,
  ThreadId,
  TerminalHistoryError,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const summary = (threadId: string, terminalId: string): TerminalSummary => ({
  threadId,
  terminalId,
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 123,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: terminalId,
  updatedAt: "2026-10-03T00:00:00.000Z",
});

it.effect("archive cleanup closes ordinary terminals but retains preview-owned terminals", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-archive-" });
    const config = yield* Effect.provide(
      ServerConfig.ServerConfig,
      ServerConfig.layerTest(process.cwd(), root),
    );
    const closed = yield* Ref.make<ReadonlyArray<string>>([]);
    const closeCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const previewLease: PreviewHosting.PreviewHostingLease = {
      id: "lease-preview",
      threadId: "thread-1",
      terminalId: "preview-terminal",
      command: "pnpm dev --port 5173",
      cwd: "/workspace",
      worktreePath: "/workspace",
      url: "http://localhost:5173/",
      handedOffAt: "2026-10-03T00:00:00.000Z",
      expiresAt: "2026-10-04T00:00:00.000Z",
      status: "active",
    };
    const layer = ResourceCleanupService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(PreviewManager.PreviewManager)({
            close: () => Effect.die("Archived cleanup must preserve browser tabs"),
          }),
          ServerConfig.layer(config),
          Layer.mock(TerminalManager.TerminalManager)({
            metadata: Effect.succeed([
              summary("thread-1", "preview-terminal"),
              summary("thread-1", "shell-terminal"),
            ]),
            close: ({ terminalId, deleteHistory }) =>
              Ref.update(closed, (values) => [...values, `${terminalId}:${String(deleteHistory)}`]),
            closeThreadExcept: (threadId, retainedTerminalIds) =>
              Ref.update(closeCalls, (values) => [
                ...values,
                `${threadId}:${retainedTerminalIds.join(",")}`,
              ]),
          }),
          Layer.mock(PreviewHosting.PreviewHosting)({
            list: (threadId) => Effect.succeed(threadId === "thread-1" ? [previewLease] : []),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupArchivedTerminals("thread-1");
      assert.deepStrictEqual(yield* Ref.get(closed), []);
      assert.deepStrictEqual(yield* Ref.get(closeCalls), ["thread-1:preview-terminal"]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "archive cleanup runs despite failed lease lookup and retains the preview namespace",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-archive-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const closed = yield* Ref.make<ReadonlyArray<string>>([]);
      const closeCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = ResourceCleanupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PreviewManager.PreviewManager)({
              close: () => Effect.die("Archived cleanup must preserve browser tabs"),
            }),
            ServerConfig.layer(config),
            Layer.mock(TerminalManager.TerminalManager)({
              metadata: Effect.succeed([
                summary("thread-1", "preview-terminal"),
                summary("thread-1", "shell-terminal"),
              ]),
              close: ({ terminalId, deleteHistory }) =>
                Ref.update(closed, (values) => [
                  ...values,
                  `${terminalId}:${String(deleteHistory)}`,
                ]),
              closeThreadExcept: (threadId, retainedTerminalIds, prefixes) =>
                Ref.update(closeCalls, (values) => [
                  ...values,
                  `${threadId}:${retainedTerminalIds.join(",")}:${prefixes?.join(",")}`,
                ]),
            }),
            Layer.mock(PreviewHosting.PreviewHosting)({
              list: () =>
                Effect.fail(
                  new PreviewHosting.PreviewHostingError({
                    operation: "persist",
                    statePath: "/state/preview-hosting.json",
                    cause: new Error("unreadable lease state"),
                  }),
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
        const result = yield* Effect.result(cleanup.cleanupArchivedTerminals("thread-1"));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.operation, "preview");
        assert.deepStrictEqual(yield* Ref.get(closed), []);
        assert.deepStrictEqual(yield* Ref.get(closeCalls), ["thread-1::preview-"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "closes all deleted-thread terminals despite preview failure and retains the retry error",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-delete-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const operations = yield* Ref.make<ReadonlyArray<string>>([]);
      const previewStopError = new PreviewHosting.PreviewHostingError({
        operation: "persist",
        statePath: "/state/preview-hosting.json",
        cause: new Error("preview terminal did not stop"),
      });
      const terminalError = new TerminalHistoryError({
        operation: "truncate",
        threadId: "thread-both-fail",
        terminalId: "shell",
      });
      const layer = ResourceCleanupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerConfig.layer(config),
            Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
            Layer.mock(TerminalManager.TerminalManager)({
              close: ({ threadId, deleteHistory }) =>
                Ref.update(operations, (values) => [
                  ...values,
                  `terminals:${threadId}:${String(deleteHistory)}`,
                ]).pipe(
                  Effect.andThen(
                    threadId === "thread-both-fail" ? Effect.fail(terminalError) : Effect.void,
                  ),
                ),
            }),
            Layer.mock(PreviewHosting.PreviewHosting)({
              removeThread: (threadId) =>
                Ref.update(operations, (values) => [...values, `preview:${threadId}`]).pipe(
                  Effect.andThen(Effect.fail(previewStopError)),
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
        const result = yield* Effect.result(cleanup.cleanupTerminals("thread-1"));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "ResourceCleanupError");
          if (result.failure._tag === "ResourceCleanupError") {
            assert.equal(result.failure.operation, "preview");
          }
        }
        assert.deepStrictEqual(yield* Ref.get(operations), [
          "preview:thread-1",
          "terminals:thread-1:true",
        ]);
        // A retained startup error must not block cleanup for an unrelated deleted thread.
        const retry = yield* Effect.result(cleanup.cleanupTerminals("thread-without-preview"));
        assert.equal(retry._tag, "Failure");
        assert.deepStrictEqual(yield* Ref.get(operations), [
          "preview:thread-1",
          "terminals:thread-1:true",
          "preview:thread-without-preview",
          "terminals:thread-without-preview:true",
        ]);
        const both = yield* Effect.result(cleanup.cleanupTerminals("thread-both-fail"));
        assert.equal(both._tag, "Failure");
        if (both._tag === "Failure") {
          assert.deepStrictEqual(both.failure.cause, {
            preview: previewStopError,
            terminal: terminalError,
          });
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("removes preview leases before closing all terminals on deletion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-delete-order-" });
    const config = yield* Effect.provide(
      ServerConfig.ServerConfig,
      ServerConfig.layerTest(process.cwd(), root),
    );
    const operations = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = ResourceCleanupService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layer(config),
          Layer.mock(PreviewManager.PreviewManager)({
            close: ({ threadId }) =>
              Ref.update(operations, (values) => [...values, `browser:${threadId}`]),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            close: ({ threadId }) =>
              Ref.update(operations, (values) => [...values, `terminals:${threadId}`]),
          }),
          Layer.mock(PreviewHosting.PreviewHosting)({
            removeThread: (threadId) =>
              Ref.update(operations, (values) => [...values, `preview:${threadId}`]),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupTerminals("thread-1");
      assert.deepStrictEqual(yield* Ref.get(operations), [
        "browser:thread-1",
        "preview:thread-1",
        "terminals:thread-1",
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("deletion closes every browser tab, preserves other threads, and is replay-safe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-browser-" });
    const config = yield* Effect.provide(
      ServerConfig.ServerConfig,
      ServerConfig.layerTest(process.cwd(), root),
    );
    const browserLayer = PreviewManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, ServerConfig.layer(config)),
      ),
    );
    const layer = ResourceCleanupService.layer.pipe(
      Layer.provideMerge(browserLayer),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layer(config),
          Layer.mock(TerminalManager.TerminalManager)({
            close: () => Effect.void,
            closeThreadExcept: () => Effect.void,
          }),
          Layer.mock(PreviewHosting.PreviewHosting)({
            list: () => Effect.succeed([]),
            removeThread: () => Effect.void,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const browser = yield* PreviewManager.PreviewManager;
      const deleted = ThreadId.make("deleted-browser-thread");
      const retained = ThreadId.make("retained-browser-thread");
      yield* browser.open({ threadId: deleted, runtime: "server" });
      yield* browser.open({ threadId: deleted, runtime: "desktop" });
      const retainedTab = yield* browser.open({ threadId: retained, runtime: "server" });
      yield* cleanup.cleanupArchivedTerminals(deleted);
      assert.equal((yield* browser.list({ threadId: deleted })).sessions.length, 2);
      yield* cleanup.cleanupTerminals(deleted);
      assert.deepStrictEqual((yield* browser.list({ threadId: deleted })).sessions, []);
      assert.deepStrictEqual((yield* browser.list({ threadId: retained })).sessions, [retainedTab]);
      const revision = (yield* browser.list({})).revision;
      yield* cleanup.cleanupTerminals(deleted);
      assert.equal((yield* browser.list({})).revision, revision);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "browser-close failure leaves a retryable error and still cleans hosting and terminals",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "resource-cleanup-browser-retry-" });
      const config = yield* Effect.provide(
        ServerConfig.ServerConfig,
        ServerConfig.layerTest(process.cwd(), root),
      );
      const attempts = yield* Ref.make(0);
      const operations = yield* Ref.make<ReadonlyArray<string>>([]);
      const closeError = new PreviewRecoveryStorageError({ cause: new Error("close failed") });
      const layer = ResourceCleanupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerConfig.layer(config),
            Layer.mock(PreviewManager.PreviewManager)({
              close: ({ threadId, tabId }) =>
                Effect.gen(function* () {
                  assert.equal(threadId, "deleted-browser-thread");
                  assert.equal(tabId, undefined);
                  const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
                  if (attempt === 1) return yield* Effect.fail(closeError);
                }),
            }),
            Layer.mock(PreviewHosting.PreviewHosting)({
              removeThread: () => Ref.update(operations, (values) => [...values, "hosting"]),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              close: () => Ref.update(operations, (values) => [...values, "terminals"]),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
        const first = yield* Effect.result(cleanup.cleanupTerminals("deleted-browser-thread"));
        assert.equal(first._tag, "Failure");
        if (first._tag === "Failure") {
          assert.equal(first.failure.operation, "preview");
          assert.deepStrictEqual(first.failure.cause, { browser: closeError });
        }
        assert.deepStrictEqual(yield* Ref.get(operations), ["hosting", "terminals"]);
        yield* cleanup.cleanupTerminals("deleted-browser-thread");
        assert.equal(yield* Ref.get(attempts), 2);
        assert.deepStrictEqual(yield* Ref.get(operations), [
          "hosting",
          "terminals",
          "hosting",
          "terminals",
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
