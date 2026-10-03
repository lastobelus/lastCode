import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TerminalSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
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
    const layer = ResourceCleanupService.live.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
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

it.effect("removes preview leases before closing terminals and propagates stop failures", () =>
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
    const layer = ResourceCleanupService.live.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layer(config),
          Layer.mock(TerminalManager.TerminalManager)({
            close: ({ threadId }) =>
              Ref.update(operations, (values) => [...values, `terminals:${threadId}`]),
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
      assert.deepStrictEqual(yield* Ref.get(operations), ["preview:thread-1"]);
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
    const layer = ResourceCleanupService.live.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layer(config),
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
        "preview:thread-1",
        "terminals:thread-1",
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
