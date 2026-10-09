import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
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

const seedLiveCaller = Effect.fnUntraced(function* () {
  const family = yield* seedFamily();
  const { store, now } = family;
  const root = yield* store.getThread(rootId);
  const providerThreadId = ProviderThreadId.make("archive-family:live-provider-thread");
  const runId = RunId.make("archive-family:live-caller-run");
  yield* store.apply({
    id: EventId.make("archive-family:live-provider-thread"),
    type: "provider-thread.updated",
    threadId: rootId,
    occurredAt: now,
    payload: {
      id: providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerSessionId: ProviderSessionId.make(scope.thread!.providerSessionId),
      appThreadId: rootId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* store.apply({
    id: EventId.make("archive-family:live-caller-owner"),
    type: "thread.metadata-updated",
    threadId: rootId,
    occurredAt: now,
    payload: { ...root, activeProviderThreadId: providerThreadId },
  });
  yield* store.apply({
    id: EventId.make("archive-family:live-caller-run"),
    type: "run.updated",
    threadId: rootId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId: rootId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: root.modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("archive-family:live-caller-input"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return { ...family, runId };
});

it.effect("a full-access client discovers the idle recursive family before archive", () =>
  Effect.gen(function* () {
    yield* seedFamily();
    const threads = yield* ThreadManagement.ThreadManagementService;
    const result = yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope);
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const family = yield* decodeFamily(result.structuredContent);
    expect(family.childThreadIds.toSorted()).toEqual([appId, nestedId, nativeId].toSorted());
    expect(family.promotableChildThreadIds).toEqual([]);
    expect(family.keptThreadIds).toEqual([]);
    expect(family.activeThreadIds).toEqual([]);
    expect(family.unreadThreadIds).toEqual([]);
    expect(family).toMatchObject({
      nativeStopCount: 2,
      requiresConfirmation: false,
      canPromote: false,
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

it.effect("a live provider caller inspects its current family without an explicit target", () =>
  Effect.gen(function* () {
    const { store, runId } = yield* seedLiveCaller();
    const shell = yield* store.getThreadShell(rootId);
    expect(shell?.activeRunId).toBe(runId);
    expect(shell?.providerInstanceId).toBe(scope.thread!.providerInstanceId);
    const result = yield* invoke("t3_thread_archive_family", {}, scope);
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const family = yield* decodeFamily(result.structuredContent);
    expect(family.childThreadIds.toSorted()).toEqual([appId, nestedId, nativeId].toSorted());
    expect(family.activeThreadIds).toEqual([rootId]);
    expect(family.activeChildThreadIds).toEqual([]);
    expect(family.unreadThreadIds).toEqual([]);
    expect(family.requiresConfirmation).toBe(true);
    expect((yield* store.getThread(rootId)).archivedAt).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["idle", "wrong-provider"] as const)(
  "refuses implicit family inspection from an %s provider caller",
  (state) =>
    Effect.gen(function* () {
      if (state === "idle") yield* seedFamily();
      else yield* seedLiveCaller();
      const invocation =
        state === "idle"
          ? scope
          : {
              ...scope,
              thread: {
                ...scope.thread!,
                providerInstanceId: ProviderInstanceId.make("another-provider"),
              },
            };
      const refused = yield* invoke("t3_thread_archive_family", {}, invocation);
      expect(declaredFailure(refused)).toMatchObject({ code: "parent_not_active" });
    }).pipe(Effect.provide(testLayer)),
);

it.effect("discovers mixed recursive creator groups and delegated ownership through MCP", () =>
  Effect.gen(function* () {
    const { store, now, child } = yield* seedFamily();
    const { thread: root } =
      yield* (yield* ThreadManagement.ThreadManagementService).getThreadRecords(rootId, []);
    const interactiveId = ThreadId.make("archive-family:interactive");
    const delegatedId = ThreadId.make("archive-family:interactive-delegated");
    const nestedInteractiveId = ThreadId.make("archive-family:nested-interactive");
    const separateId = ThreadId.make("archive-family:separate-conversation");
    const foreignId = ThreadId.make("archive-family:foreign-conversation");
    const grouped = (id: ThreadId, creatorThreadId: ThreadId): OrchestrationV2AppThread => ({
      ...root,
      id,
      createdBy: "agent",
      creationSource: "mcp",
      creatorThreadId,
      creatorGrouping: "grouped",
    });
    for (const thread of [
      grouped(interactiveId, rootId),
      child(delegatedId, interactiveId),
      grouped(nestedInteractiveId, delegatedId),
      { ...grouped(separateId, rootId), creatorGrouping: "independent" as const },
      child(ThreadId.make("archive-family:separate-descendant"), separateId),
      { ...grouped(foreignId, rootId), projectId: ProjectId.make("archive-family:other-project") },
    ])
      yield* store.apply({
        id: EventId.make(`create:${thread.id}`),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      });
    const family = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope))
        .structuredContent,
    );
    expect(family.childThreadIds.toSorted()).toEqual(
      [appId, nestedId, nativeId, interactiveId, delegatedId, nestedInteractiveId].toSorted(),
    );
    expect(family.promotableChildThreadIds).toEqual([]);
    expect(family.keptThreadIds).toEqual([]);
    expect(family.activeThreadIds).toEqual([]);
    expect(family.unreadThreadIds).toEqual([]);
    expect(family.requiresConfirmation).toBe(false);
    expect(family.canPromote).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["active", "unread"] as const)(
  "reports %s responses without confusing review with consent to stop",
  (state) =>
    Effect.gen(function* () {
      const { store, now } = yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      if (state === "active") {
        const runId = RunId.make("archive-family:unknown-live-run");
        yield* store.apply({
          id: EventId.make("archive-family:unknown-live-run"),
          type: "run.updated",
          threadId: appId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: appId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "example-model" },
            providerThreadId: null,
            userMessageId: MessageId.make("archive-family:live-input"),
            rootNodeId: null,
            activeAttemptId: RunAttemptId.make("archive-family:unknown-attempt"),
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      } else {
        yield* store.apply({
          id: EventId.make("archive-family:unexamined-response"),
          type: "message.updated",
          threadId: appId,
          occurredAt: now,
          payload: {
            id: MessageId.make("archive-family:unexamined-response"),
            threadId: appId,
            runId: null,
            nodeId: null,
            role: "assistant",
            text: "Finished response",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const family = yield* decodeFamily(
        (yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope))
          .structuredContent,
      );
      expect(family.activeThreadIds).toEqual(state === "active" ? [appId] : []);
      expect(family.unreadThreadIds).toEqual(state === "unread" ? [appId] : []);
      expect(family.requiresConfirmation).toBe(true);
      expect(family.canPromote).toBe(false);
      const idle = yield* invoke(
        "t3_thread_organize",
        {
          threadId: rootId,
          action: "archive",
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: family.childThreadIds,
        },
        clientScope,
      );
      expect(declaredFailure(idle)).toMatchObject({ code: "orchestration_error" });
      for (const id of [rootId, ...family.childThreadIds])
        expect((yield* threads.getThreadShell(id))?.archivedAt).toBeNull();
      const reviewed = yield* invoke(
        "t3_thread_organize",
        {
          threadId: rootId,
          action: "archive",
          childDisposition: "archive_after_review",
          expectedChildThreadIds: family.childThreadIds,
        },
        clientScope,
      );
      if (state === "active") {
        expect(declaredFailure(reviewed)).toMatchObject({ code: "orchestration_error" });
        expect((yield* threads.getThreadRecords(appId, ["runs"])).runs[0]?.status).toBe("running");
      } else {
        expect(reviewed.isError).toBe(false);
        for (const id of [rootId, ...family.childThreadIds])
          expect((yield* threads.getThreadShell(id))?.archivedAt).not.toBeNull();
        expect((yield* threads.getThreadShell(appId))?.lastVisitedAt).toBeNull();
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([rootId, appId, nestedId])(
  "refuses archive when participant %s is protected",
  (protectedId) =>
    Effect.gen(function* () {
      const { store, now } = yield* seedFamily();
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { thread: protectedThread } = yield* threads.getThreadRecords(protectedId, []);
      yield* store.apply({
        id: EventId.make("archive-family:protect-owner"),
        type: "thread.metadata-updated",
        threadId: protectedId,
        occurredAt: now,
        payload: { ...protectedThread, persistent: true },
      });
      const family = yield* decodeFamily(
        (yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope))
          .structuredContent,
      );
      expect(family.childThreadIds).toHaveLength(3);
      expect(family.promotableChildThreadIds).toEqual([]);
      expect(family.keptThreadIds).toEqual([]);
      expect(family.protectedChildThreadIds).toEqual(protectedId === rootId ? [] : [protectedId]);
      expect(family.canPromote).toBe(false);
      expect(family.canStopAndArchive).toBe(false);
      for (const childDisposition of [
        "archive_if_idle",
        "archive_after_review",
        "stop_and_archive",
      ])
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
      (yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope))
        .structuredContent,
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
      message: "The conversation family changed. Review the archive confirmation again.",
    });
    const fresh = yield* decodeFamily(
      (yield* invoke("t3_thread_archive_family", { threadId: rootId }, clientScope))
        .structuredContent,
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

it.effect("refuses read-only family inspection before activity repair", () =>
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
    for (const tool of ["t3_thread_archive_family", "t3_thread_organize"] as const) {
      const refused = yield* invoke(
        tool,
        tool === "t3_thread_archive_family"
          ? { threadId: rootId }
          : { threadId: rootId, action: "archive", childDisposition: "archive_if_idle" },
        readOnly,
      );
      expect(declaredFailure(refused)).toMatchObject({ code: "capability_denied" });
    }
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
        kind === "capability" ? { ...clientScope, capabilities: new Set<never>() } : clientScope;
      const result = yield* invoke(
        "t3_thread_archive_family",
        kind === "missing"
          ? { threadId: ThreadId.make("archive-family:missing") }
          : kind === "capability"
            ? { threadId: rootId }
            : {},
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
