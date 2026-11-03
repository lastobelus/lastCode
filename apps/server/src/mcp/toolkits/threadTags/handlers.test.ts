import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "tag-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tag-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
it.effect("read-only clients can discover tags but cannot mutate an execution target", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "t3_thread_tag_vocabulary", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("Work/client");
    const matches = yield* server.callTool({
      name: "t3_thread_tag_query",
      arguments: { tag: "Work" },
    });
    expect(matches.isError, JSON.stringify(matches)).not.toBe(true);
    expect(JSON.stringify(matches.content)).toContain("t3-thread://v2/tag-test/target");
    expect(JSON.stringify(matches.content)).toContain("Work/client");
    const denied = yield* server.callTool({
      name: "t3_thread_tag_set",
      arguments: { threadId: "target", tag: "Work", tagged: false },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("capability_denied");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadTagsToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                threads: [{ ...liveThreadShell(ThreadId.make("target")), tags: ["Work/client"] }],
                archivedThreads: [],
                snapshotSequence: 0,
              }),
            dispatch: () => Effect.die("read-only writes must never reach dispatch"),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("tag-test"),
      requestNamespace: "tag-test",
      thread: undefined,
      client: { sessionId: "test", label: "Test", access: "read-only" },
      issuedAt: 0,
      capabilities: new Set(["orchestration"] as const),
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
  ),
);
it.effect("mutation checks the destination thread's execution mode before dispatch", () =>
  Effect.gen(function* () {
    const denied = yield* (yield* McpServer.McpServer).callTool({
      name: "t3_thread_tag_set",
      arguments: { threadId: "target", tag: "Work", tagged: true },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("mode_escalation_denied");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadTagsToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            dispatch: () => Effect.die("target above caller ceiling must never reach dispatch"),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("tag-test"),
      requestNamespace: "tag-test",
      thread: undefined,
      client: { sessionId: "test", label: "Test", access: "approval-required" },
      issuedAt: 0,
      capabilities: new Set(["orchestration"] as const),
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
  ),
);
