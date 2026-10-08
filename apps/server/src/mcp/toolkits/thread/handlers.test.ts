import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkit } from "./tools.ts";

const database = SqlitePersistence.layerMemory;
const threadsLayer = ThreadManagement.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProviderReplayHarness.layerWithRegistry(
        { name: "mcp-archive-family" },
        ProviderAdapterRegistry.layerFromAdapters([]),
        { databaseLayer: database },
      ),
      ProjectionStore.layer.pipe(Layer.provide(database)),
    ),
  ),
);
const testLayer = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(threadsLayer),
  Layer.provide(NodeCrypto.layer),
);
const rootId = ThreadId.make("archive-family:root");
const appId = ThreadId.make("archive-family:app");
const nestedId = ThreadId.make("archive-family:nested-native");
const nativeId = ThreadId.make("archive-family:native");
const forkId = ThreadId.make("archive-family:fork");
const independentId = ThreadId.make("archive-family:independent");
const instanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("archive-family:environment"),
  requestNamespace: "archive-family:session",
  thread: {
    threadId: rootId,
    providerSessionId: "archive-family:session",
    providerInstanceId: instanceId,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const clientScope: McpInvocationContext.McpInvocationScope = {
  ...scope,
  thread: undefined,
  client: { sessionId: "archive-family:client", label: "Test client", access: "full-access" },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "archive-family", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "archive-family", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const invoke = Effect.fnUntraced(function* (
  name: string,
  args: Record<string, unknown>,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
const decodeFamily = Schema.decodeUnknownEffect(
  ThreadToolkit.tools.t3_thread_archive_family.successSchema,
);
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
const seedFamily = Effect.fnUntraced(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const root: OrchestrationV2AppThread = {
    id: rootId,
    projectId: ProjectId.make("archive-family:project"),
    title: "Planning task",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "example-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const child = (id: ThreadId, parent: ThreadId): OrchestrationV2AppThread => ({
    ...root,
    id,
    createdBy: "agent",
    creationSource: "mcp",
    lineage: { ...root.lineage, parentThreadId: parent, relationshipToParent: "subagent" },
  });
  for (const thread of [
    root,
    child(appId, rootId),
    { ...child(nestedId, appId), creationSource: "provider" as const },
    { ...child(nativeId, rootId), creationSource: "provider" as const },
    {
      ...child(forkId, rootId),
      lineage: { ...root.lineage, parentThreadId: rootId, relationshipToParent: "fork" as const },
    },
    {
      ...child(independentId, rootId),
      lineage: { ...child(independentId, rootId).lineage, independent: true },
    },
  ])
    yield* store.apply({
      id: EventId.make(`create:${thread.id}`),
      type: "thread.created",
      threadId: thread.id,
      occurredAt: now,
      payload: thread,
    });
  return { store, now, child };
});

it.effect.each([false, true])(
  "discovers the recursive family before archive (explicit=%s)",
  (explicit) =>
    Effect.gen(function* () {
      yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const result = yield* invoke(
        "t3_thread_archive_family",
        explicit ? { threadId: rootId } : {},
      );
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      const family = yield* decodeFamily(result.structuredContent);
      expect(family.childThreadIds.toSorted()).toEqual([appId, nestedId, nativeId].toSorted());
      expect(family.promotableChildThreadIds).toEqual([appId]);
      expect(family.keptThreadIds.toSorted()).toEqual([appId, nestedId].toSorted());
      expect(family).toMatchObject({
        nativeStopCount: 1,
        requiresConfirmation: false,
        canPromote: true,
        canStopAndArchive: true,
      });
      for (const id of [rootId, ...family.childThreadIds])
        expect((yield* threads.getThreadShell(id))?.archivedAt).toBeNull();
      const archived = yield* invoke(
        "t3_thread_organize",
        {
          threadId: rootId,
          action: "archive",
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: family.childThreadIds,
        },
        clientScope,
      );
      expect(archived.isError).toBe(false);
      for (const id of [rootId, ...family.childThreadIds])
        expect((yield* threads.getThreadShell(id))?.archivedAt).not.toBeNull();
      for (const id of [forkId, independentId])
        expect((yield* threads.getThreadShell(id))?.archivedAt).toBeNull();
    }).pipe(Effect.provide(testLayer)),
);

it.effect("does not offer archive choices for a protected family owner", () =>
  Effect.gen(function* () {
    const { store, now } = yield* seedFamily();
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { thread: root } = yield* threads.getThreadRecords(rootId, []);
    yield* store.apply({
      id: EventId.make("archive-family:protect-owner"),
      type: "thread.metadata-updated",
      threadId: rootId,
      occurredAt: now,
      payload: { ...root, persistent: true },
    });
    const family = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", {})).structuredContent,
    );
    expect(family.childThreadIds).toHaveLength(3);
    expect(family.promotableChildThreadIds).toEqual([appId]);
    expect(family.protectedChildThreadIds).toEqual([]);
    expect(family.canPromote).toBe(false);
    expect(family.canStopAndArchive).toBe(false);
    for (const childDisposition of ["archive_if_idle", "stop_and_archive", "promote"])
      expect(
        declaredFailure(
          yield* invoke(
            "t3_thread_organize",
            {
              threadId: rootId,
              action: "archive",
              childDisposition,
              expectedChildThreadIds: family.childThreadIds,
            },
            clientScope,
          ),
        ),
      ).toMatchObject({ code: "orchestration_error" });
    for (const id of [rootId, ...family.childThreadIds]) {
      const shell = yield* threads.getThreadShell(id);
      expect(shell?.archivedAt).toBeNull();
      expect(shell?.lineage.independent).not.toBe(true);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([false, true])(
  "failed participants inspect and retry the full family (archived owner=%s)",
  (archivedOwner) =>
    Effect.gen(function* () {
      const { store, now } = yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const oldCommandId = CommandId.make("archive-family:failed-operation");
      const participants = [rootId, appId, nestedId, nativeId];
      for (const id of participants) {
        const { thread } = yield* threads.getThreadRecords(id, []);
        const failed = { threadId: rootId, commandId: oldCommandId, status: "failed" as const };
        yield* store.apply({
          id: EventId.make(`failed-archive:${id}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            ...(id === appId ? { runtimeMode: "approval-required" as const } : {}),
            ...(id === rootId && archivedOwner
              ? { archivedAt: now, archivedWith: { threadId: rootId, commandId: oldCommandId } }
              : {}),
            archivePending:
              id === rootId
                ? {
                    ...failed,
                    childDisposition: "stop_and_archive",
                    childThreadIds: participants.slice(1),
                    archiveThreadIds: participants,
                    promoteThreadIds: [],
                  }
                : failed,
          },
        });
      }
      const family = yield* decodeFamily(
        (yield* invoke("t3_thread_archive_family", { threadId: appId }, clientScope))
          .structuredContent,
      );
      expect(family.childThreadIds.toSorted()).toEqual([appId, nestedId, nativeId].toSorted());
      const retry = {
        threadId: appId,
        action: "archive",
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: family.childThreadIds,
      };
      const limited = {
        ...clientScope,
        client: { ...clientScope.client!, access: "approval-required" as const },
      };
      expect((yield* invoke("t3_thread_organize", retry, limited)).isError).toBe(true);
      expect((yield* threads.getThreadShell(rootId))?.archivePending?.commandId).toBe(oldCommandId);
      const accepted = yield* invoke("t3_thread_organize", retry, clientScope);
      expect(accepted.isError, JSON.stringify(accepted.content)).toBe(false);
      for (const id of participants) {
        const shell = yield* threads.getThreadShell(id);
        expect(shell?.archivedAt).not.toBeNull();
        expect(shell?.archivePending).toBeNull();
        expect(shell?.archivedWith?.threadId).toBe(rootId);
      }
      for (const id of [forkId, independentId])
        expect((yield* threads.getThreadShell(id))?.archivedAt).toBeNull();
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["owner", "participant", "stale", "archived", "limited", "read-only"] as const)(
  "dismisses only the observed failed archive through MCP (%s)",
  (state) =>
    Effect.gen(function* () {
      const { store, now } = yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const archiveCommandId = CommandId.make("archive-family:dismiss-attempt");
      const participants = [rootId, appId, nestedId, nativeId];
      for (const id of participants) {
        const { thread } = yield* threads.getThreadRecords(id, []);
        const failed = { threadId: rootId, commandId: archiveCommandId, status: "failed" as const };
        yield* store.apply({
          id: EventId.make(`dismiss-failed:${id}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            ...(state === "limited" && id === rootId
              ? { runtimeMode: "approval-required" as const }
              : {}),
            ...(state === "archived" && id === rootId
              ? { archivedAt: now, archivedWith: { threadId: rootId, commandId: archiveCommandId } }
              : {}),
            archivePending:
              id === rootId
                ? {
                    ...failed,
                    childDisposition: "stop_and_archive",
                    childThreadIds: participants.slice(1),
                    archiveThreadIds: participants,
                    promoteThreadIds: [],
                  }
                : failed,
          },
        });
      }
      const before = yield* Effect.forEach(participants, (id) => threads.getThreadRecords(id, []));
      const invocation =
        state === "limited" || state === "read-only"
          ? {
              ...clientScope,
              client: {
                ...clientScope.client!,
                access:
                  state === "limited" ? ("approval-required" as const) : ("read-only" as const),
              },
            }
          : clientScope;
      const result = yield* invoke(
        "t3_thread_organize",
        {
          threadId:
            state === "owner" || state === "limited" || state === "read-only" ? rootId : appId,
          action: "unarchive",
          expectedArchiveCommandId:
            state === "stale" ? CommandId.make("older-attempt") : archiveCommandId,
        },
        invocation,
      );
      if (state === "owner" || state === "participant") {
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        for (const previous of before) {
          const current = (yield* threads.getThreadRecords(previous.thread.id, [])).thread;
          expect(current).toEqual({
            ...previous.thread,
            archivePending: null,
            updatedAt: current.updatedAt,
          });
        }
      } else {
        expect(result.isError).toBe(true);
        expect(declaredFailure(result)).toMatchObject({
          code:
            state === "read-only"
              ? "capability_denied"
              : state === "limited"
                ? "runtime_mode_escalation_denied"
                : "orchestration_error",
        });
        if (state === "archived")
          expect(declaredFailure(result).message).toBe(
            "This thread family is already archived. Restore it from Settings > Archived threads.",
          );
        for (const previous of before)
          expect((yield* threads.getThreadRecords(previous.thread.id, [])).thread).toEqual(
            previous.thread,
          );
      }
      for (const id of [forkId, independentId]) {
        const shell = yield* threads.getThreadShell(id);
        expect(shell?.archivedAt).toBeNull();
        expect(shell?.archivePending ?? null).toBeNull();
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["dismissed", "newer-failed", "stopping", "explicit-stale"] as const)(
  "retains the participant's observed attempt when MCP retry sees %s on its owner",
  (state) =>
    Effect.gen(function* () {
      const { store, now } = yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const attempt = CommandId.make("archive-family:observed-failure");
      const newerAttempt = CommandId.make("archive-family:newer-failure");
      const participants = [rootId, appId, nestedId, nativeId];
      for (const id of participants) {
        const { thread } = yield* threads.getThreadRecords(id, []);
        const failed = { threadId: rootId, commandId: attempt, status: "failed" as const };
        yield* store.apply({
          id: EventId.make(`retry-observed:${id}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            archivePending:
              id === rootId
                ? {
                    ...failed,
                    childDisposition: "stop_and_archive",
                    childThreadIds: participants.slice(1),
                    archiveThreadIds: participants,
                    promoteThreadIds: [],
                  }
                : failed,
          },
        });
      }
      let before = yield* Effect.forEach(participants, (id) => threads.getThreadRecords(id, []));
      let changed = false;
      let dispatched: OrchestrationV2ServerCommand | undefined;
      const retryThreads = ThreadManagement.ThreadManagementService.of({
        ...threads,
        getProjectThreadRecords: (input, fields, filter) =>
          Effect.gen(function* () {
            // The participant was already read. Another client changes the
            // owner before normalization finishes and archive is dispatched.
            if (input.threadId === rootId && !changed && state !== "explicit-stale") {
              changed = true;
              if (state === "dismissed")
                yield* threads.dispatch({
                  type: "thread.unarchive",
                  commandId: CommandId.make("archive-family:dismiss-before-retry"),
                  threadId: rootId,
                  expectedArchiveCommandId: attempt,
                });
              else {
                const { thread } = yield* threads.getThreadRecords(rootId, []);
                const plan = thread.archivePending;
                expect(plan !== null && plan !== undefined && "childThreadIds" in plan).toBe(true);
                yield* store.apply({
                  id: EventId.make(`retry-owner-changed:${state}`),
                  type: "thread.metadata-updated",
                  threadId: rootId,
                  occurredAt: now,
                  payload: {
                    ...thread,
                    archivePending: {
                      ...plan!,
                      commandId: state === "newer-failed" ? newerAttempt : attempt,
                      status: state === "stopping" ? "stopping" : "failed",
                    },
                  },
                });
              }
              before = yield* Effect.forEach(participants, (id) =>
                threads.getThreadRecords(id, []),
              );
            }
            return yield* threads.getProjectThreadRecords(input, fields, filter);
          }).pipe(Effect.orDie),
        dispatch: (command) => {
          dispatched = command;
          return threads.dispatch(command);
        },
      });
      const retryLayer = McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.succeed(ThreadManagement.ThreadManagementService, retryThreads)),
        Layer.provide(NodeCrypto.layer),
      );
      const result = yield* invoke(
        "t3_thread_organize",
        {
          threadId: appId,
          action: "archive",
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: participants.slice(1),
          ...(state === "explicit-stale" ? { expectedArchiveCommandId: newerAttempt } : {}),
        },
        clientScope,
      ).pipe(Effect.provide(retryLayer));
      expect(result.isError).toBe(true);
      expect(declaredFailure(result)).toMatchObject({
        code: "orchestration_error",
        message:
          state === "stopping"
            ? "This conversation is stopping before it is archived. Wait for the archive to finish."
            : "This failed archive changed. Review the conversation before retrying it.",
      });
      expect(dispatched).toMatchObject({
        type: "thread.archive",
        threadId: rootId,
        expectedArchiveCommandId: state === "explicit-stale" ? newerAttempt : attempt,
      });
      for (const previous of before)
        expect((yield* threads.getThreadRecords(previous.thread.id, [])).thread).toEqual(
          previous.thread,
        );
    }).pipe(Effect.provide(threadsLayer)),
);

it.effect("requires fresh family inspection when a nested child is added", () =>
  Effect.gen(function* () {
    const { store, now, child } = yield* seedFamily();
    const first = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", {})).structuredContent,
    );
    const lateId = ThreadId.make("archive-family:late-child");
    yield* store.apply({
      id: EventId.make("create:late-child"),
      type: "thread.created",
      threadId: lateId,
      occurredAt: now,
      payload: child(lateId, appId),
    });
    const stale = yield* invoke(
      "t3_thread_organize",
      {
        threadId: rootId,
        action: "archive",
        childDisposition: "archive_if_idle",
        expectedChildThreadIds: first.childThreadIds,
      },
      clientScope,
    );
    expect(declaredFailure(stale)).toMatchObject({
      code: "orchestration_error",
      message: "The subagents changed. Review the archive choices again.",
    });
    const fresh = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", {})).structuredContent,
    );
    expect(fresh.childThreadIds.toSorted()).toEqual([...first.childThreadIds, lateId].toSorted());
    const threads = yield* ThreadManagement.ThreadManagementService;
    for (const id of [rootId, ...fresh.childThreadIds])
      expect((yield* threads.getThreadShell(id))?.archivedAt).toBeNull();
    const accepted = yield* invoke(
      "t3_thread_organize",
      {
        threadId: rootId,
        action: "archive",
        childDisposition: "archive_if_idle",
        expectedChildThreadIds: fresh.childThreadIds,
      },
      clientScope,
    );
    expect(accepted.isError).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lets a read-only client inspect choices without allowing archive", () =>
  Effect.gen(function* () {
    yield* seedFamily();
    const readOnly = {
      ...clientScope,
      client: {
        sessionId: "archive-family:client",
        label: "Test client",
        access: "read-only" as const,
      },
    };
    const family = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", { threadId: rootId }, readOnly)).structuredContent,
    );
    expect(family.childThreadIds).toHaveLength(3);
    const refused = yield* invoke(
      "t3_thread_organize",
      {
        threadId: rootId,
        action: "archive",
        childDisposition: "archive_if_idle",
        expectedChildThreadIds: family.childThreadIds,
      },
      readOnly,
    );
    expect(declaredFailure(refused)).toMatchObject({ code: "capability_denied" });
    const threads = yield* ThreadManagement.ThreadManagementService;
    expect((yield* threads.getThreadShell(rootId))?.archivedAt).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["missing", "capability", "no-target"] as const)(
  "refuses an unavailable archive family (%s)",
  (kind) =>
    Effect.gen(function* () {
      yield* seedFamily();
      const invocation =
        kind === "no-target"
          ? clientScope
          : kind === "capability"
            ? { ...scope, capabilities: new Set<never>() }
            : scope;
      const result = yield* invoke(
        "t3_thread_archive_family",
        kind === "missing" ? { threadId: ThreadId.make("archive-family:missing") } : {},
        invocation,
      );
      expect(declaredFailure(result)).toMatchObject({
        code:
          kind === "missing"
            ? "thread_not_found"
            : kind === "capability"
              ? "capability_denied"
              : "target_required",
      });
    }).pipe(Effect.provide(testLayer)),
);
