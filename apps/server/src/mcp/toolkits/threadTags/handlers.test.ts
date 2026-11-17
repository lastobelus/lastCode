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
it.effect.each([
  {
    clientKind: "internal",
    hostedAppUrl: undefined,
    expectedLink: "[target](t3-thread://v2/tag-test/target)",
  },
  {
    clientKind: "external",
    hostedAppUrl: "https://tags.example.test",
    expectedLink: "https://tags.example.test/threads/tag-test/target",
  },
])(
  "read-only $clientKind clients can discover tags but cannot mutate an execution target",
  ({ hostedAppUrl, expectedLink }) => {
    let reads = 0;
    const target = {
      ...liveThreadShell(ThreadId.make("target")),
      tags: ["Work/client"],
      settledOverride: "settled" as const,
    };
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const input of [
        { mode: "exact" },
        { tag: "Work", query: "wc" },
        { tag: "Work", preferredProjectId: "project" },
      ]) {
        const invalid = yield* server.callTool({ name: "t3_thread_tags", arguments: input });
        expect(invalid.isError).toBe(true);
        const content = invalid.content[0];
        expect(content?.type === "text" && JSON.parse(content.text)).toMatchObject({
          code: "invalid_request",
        });
      }
      expect(reads).toBe(0);
      const result = yield* server.callTool({ name: "t3_thread_tags", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("Work/client");
      const matches = yield* server.callTool({
        name: "t3_thread_tags",
        arguments: { tag: "Work" },
      });
      expect(matches.isError, JSON.stringify(matches)).not.toBe(true);
      expect(matches.structuredContent).toEqual({
        threads: [
          {
            threadId: "target",
            projectId: target.projectId,
            title: "target",
            environmentId: "tag-test",
            link: expectedLink,
            tags: ["Work/client"],
            settled: true,
          },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify(matches.content)).toContain("Work/client");
      const denied = yield* server.callTool({
        name: "t3_thread_tag_set",
        arguments: { threadId: "target", tag: "Work", tagged: false },
      });
      expect(denied.isError).toBe(true);
      const deniedText = denied.content[0];
      expect(deniedText?.type === "text" && JSON.parse(deniedText.text)).toMatchObject({
        code: "capability_denied",
      });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerThreadTagsToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getShellSnapshot: () =>
                Effect.sync(() => {
                  reads++;
                  return {
                    schemaVersion: 2,
                    threads: [target],
                    archivedThreads: [],
                    snapshotSequence: 0,
                  };
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
        client: { sessionId: "test", label: "Test", access: "read-only", hostedAppUrl },
        issuedAt: 0,
        capabilities: new Set(["orchestration"] as const),
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  },
);
it.effect("mutation checks the destination thread's execution mode before dispatch", () =>
  Effect.gen(function* () {
    const denied = yield* (yield* McpServer.McpServer).callTool({
      name: "t3_thread_tag_set",
      arguments: { threadId: "target", tag: "Work", tagged: true },
    });
    expect(denied.isError).toBe(true);
    const deniedText = denied.content[0];
    expect(deniedText?.type === "text" && JSON.parse(deniedText.text)).toMatchObject({
      code: "runtime_mode_escalation_denied",
      message: expect.stringContaining('Thread "target"'),
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadTagsToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
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
