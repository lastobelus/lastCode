import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ActionResume from "../actionResume/ActionResume.ts";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:mcp-create");
const parentThreadId = ThreadId.make("thread:mcp-create-parent");
const modelSelection = { instanceId, model: "gpt-5" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("MCP creation tests do not execute providers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const orchestration = ProviderReplayHarness.layerWithRegistry({ name: "mcp-create" }, registry, {
  databaseLayer: database,
  runEffectWorker: false,
});
const dependencies = Layer.mergeAll(
  database,
  AuthSessions.layer.pipe(Layer.provide(database)),
  NodeServices.layer,
  NodeCrypto.layer,
  ServerSettings.layerTest(),
  orchestration,
  registry,
  ThreadManagement.layer.pipe(Layer.provide(orchestration)),
  CommandReceiptStore.layer.pipe(Layer.provide(database)),
  ThreadCommandExecutor.layer,
  ProviderRegistryMock.layer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T00:00:00.000Z",
      models: [
        { slug: modelSelection.model, name: "Test model", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    },
  ]),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone })),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  Layer.provide(
    Layer.mock(ActionResume.ActionResume)({ readLatestSummary: () => Effect.succeed(null) }),
  ),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);
const layer = layerOrchestratorService.pipe(
  Layer.provideMerge(ThreadReadBroker.layer),
  Layer.provideMerge(dependencies),
);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-create"),
  requestNamespace: "provider-session:mcp-create",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-create",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const createParent = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const now = yield* DateTime.now;
  yield* sessions.create({
    sessionId: AuthSessionId.make("client:mcp-create"),
    subject: "paired-client",
    method: "browser-session-cookie",
    scopes: ["orchestration:read"],
    issuedAt: now,
    expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 30 * 24 * 60 * 60 * 1000),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentThreadId,
    projectId,
    title: "Parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: "/repo-worktree",
    createdBy: "user",
    creationSource: "web",
  });
  const broker = yield* ThreadReadBroker.ThreadReadBroker;
  const requests = yield* broker.connect("client:mcp-create");
  const threadReadIntent = yield* broker
    .forSession("client:mcp-create")
    .authorize(parentThreadId, MessageId.make("message:parent"));
  yield* threads.dispatch(
    {
      type: "message.dispatch",
      commandId: CommandId.make("start-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent"),
      text: "Create another thread",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    },
    threadReadIntent === undefined ? undefined : { threadReadIntent },
  );
  return { requests };
});

it.effect("names invalid grouping inputs without creating a thread", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    yield* createParent;
    for (const prompt of [undefined, "Inspect this project"]) {
      for (const groupedUnderThreadId of ["null", "missing-thread"]) {
        const clientRequestId = `bad-group:${prompt === undefined ? "empty" : "prompted"}:${groupedUnderThreadId}`;
        const error = yield* service
          .createThreads(scope, {
            clientRequestId,
            threads: [
              {
                title: "Invalid grouping",
                groupedUnderThreadId: ThreadId.make(groupedUnderThreadId),
                ...(prompt === undefined ? {} : { prompt }),
              },
            ],
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.match(error.message, /^Row 1:/);
        assert.include(error.message, "groupedUnderThreadId");
        assert.include(error.message, "JSON null");
        assert.include(error.message, "No rows were created");
        assert.include(error.message, "fresh clientRequestId");
        const retry = yield* service
          .createThreads(scope, {
            clientRequestId,
            threads: [{ title: "Corrected grouping", groupedUnderThreadId: null }],
          })
          .pipe(Effect.flip);
        assert.equal(retry.code, "invalid_request");
        assert.include(retry.message, "clientRequestId");
      }
    }
    const records = yield* service.listThreads(scope, {});
    assert.lengthOf(records.threads, 1);
    const fresh = yield* service.createThreads(scope, {
      clientRequestId: "corrected-with-new-key",
      threads: [{ title: "Corrected grouping", groupedUnderThreadId: null }],
    });
    assert.isNull(fresh.threads[0]?.groupedUnderThreadId);
  }).pipe(Effect.provide(layer)),
);

it.effect("identifies which rows need retry after partial batch creation", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    yield* createParent;
    const clientRequestId = "partial-batch";
    const alreadyCreated = { title: "First child", prompt: "Check the project" };
    const invalid = { title: "Second child", groupedUnderThreadId: ThreadId.make("null") };
    const corrected = { ...invalid, groupedUnderThreadId: null };
    const remaining = { title: "Third child" };

    for (const [row, field] of [
      [invalid, "groupedUnderThreadId"],
      [corrected, "clientRequestId"],
    ] as const) {
      const error = yield* service
        .createThreads(scope, { clientRequestId, threads: [alreadyCreated, row, remaining] })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /^Row 2:/);
      assert.include(error.message, field);
      assert.include(error.message, "The rows before row 2 were created");
      assert.include(error.message, "send it and any rows after it as a new call");
    }

    const partial = yield* service.listThreads(scope, {});
    assert.lengthOf(partial.threads, 2);
    assert.equal(
      partial.threads.filter((thread) => thread.title === alreadyCreated.title).length,
      1,
    );
    const retry = yield* service.createThreads(scope, {
      clientRequestId: "partial-batch-recovery",
      threads: [corrected, remaining],
    });
    assert.deepEqual(
      retry.threads.map((thread) => thread.title),
      [corrected.title, remaining.title],
    );
    const recovered = yield* service.listThreads(scope, {});
    assert.lengthOf(recovered.threads, 4);
    assert.equal(
      recovered.threads.filter((thread) => thread.title === alreadyCreated.title).length,
      1,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "creates empty containers, moves a large family through the service and discovers paged children",
  () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createParent;
      const created = yield* service.createThreads(scope, {
        clientRequestId: "organization-roots",
        threads: [
          { title: "Container A", groupedUnderThreadId: null },
          { title: "Container B", groupedUnderThreadId: null },
          { title: "Empty container" },
        ],
      });
      const a = created.threads[0]!.threadId;
      const b = created.threads[1]!.threadId;
      assert.equal(created.threads[2]!.groupedUnderThreadId, parentThreadId);
      for (const row of created.threads) {
        const projection = yield* threads.getThreadProjection(row.threadId);
        assert.isEmpty(projection.runs);
        assert.isEmpty(projection.messages);
        assert.isTrue(projection.thread.groupThread);
        assert.equal(projection.thread.creatorThreadId, parentThreadId);
      }
      const unkeyed = yield* service.createThreads(scope, {
        threads: [
          { title: "Owned with root placement", groupedUnderThreadId: null, prompt: "Check logs" },
          { title: "Explicitly independent", topLevel: true },
        ],
      });
      for (const [index, row] of unkeyed.threads.entries()) {
        const shell = yield* threads.getThreadShell(row.threadId);
        assert.isNull(shell?.groupedUnderThreadId);
        assert.deepEqual(shell?.creatorOrigin, {
          kind: "thread_launch",
          environmentId: scope.environmentId,
          threadId: parentThreadId,
          owned: index === 0,
        });
      }
      const members: ThreadId[] = [];
      for (let batch = 0; batch < 6; batch++) {
        const children = yield* service.createThreads(scope, {
          clientRequestId: `organization-items:${batch}`,
          threads: Array.from({ length: 20 }, (_, index) => ({
            title: `Item ${batch * 20 + index}`,
            groupedUnderThreadId: a,
          })),
        });
        members.push(...children.threads.map((row) => row.threadId));
      }
      const stage = (yield* service.createThreads(scope, {
        clientRequestId: "organization-stage",
        threads: [{ title: "Stage", groupedUnderThreadId: members[0]! }],
      })).threads[0]!.threadId;
      const firstPage = yield* service.listThreads(scope, { underThreadId: a, limit: 100 });
      const secondPage = yield* service.listThreads(scope, {
        underThreadId: a,
        limit: 100,
        cursor: firstPage.nextCursor!,
      });
      assert.equal(firstPage.total, 120);
      assert.isTrue(firstPage.threads.every((thread) => thread.groupThread === true));
      assert.isTrue((yield* service.readThread(scope, { threadId: a })).thread.groupThread);
      assert.lengthOf(firstPage.threads, 100);
      assert.lengthOf(secondPage.threads, 20);
      assert.isNull(secondPage.nextCursor);
      const items = members.map((threadId) => ({
        commandId: CommandId.make(`organization:move:${threadId}`),
        threadId,
        groupedUnderThreadId: b,
      }));
      const moved = yield* threads.setThreadParents({ projectId, items });
      assert.isTrue(
        moved.every((item) => item.status === "moved" && item.previousGroupedUnderThreadId === a),
      );
      assert.equal((yield* threads.getThreadShell(stage))?.groupedUnderThreadId, members[0]);
      const retried = yield* threads.setThreadParents({ projectId, items });
      assert.isTrue(
        retried.every((item, index) => item.replayed && item.sequence === moved[index]!.sequence),
      );
      const partial = yield* threads.setThreadParents({
        projectId,
        items: [
          {
            commandId: CommandId.make("organization:detach"),
            threadId: members[0]!,
            groupedUnderThreadId: null,
          },
          {
            commandId: CommandId.make("organization:cycle"),
            threadId: b,
            groupedUnderThreadId: members[1]!,
          },
          {
            commandId: CommandId.make("organization:untouched"),
            threadId: members[2]!,
            groupedUnderThreadId: null,
          },
        ],
      });
      assert.deepEqual(
        partial.map((item) => item.status),
        ["moved", "rejected", "not_attempted"],
      );
      const retryDetach = yield* threads.setThreadParents({ projectId, items: [items[0]!] });
      assert.equal(retryDetach[0]?.previousGroupedUnderThreadId, a);
      assert.isNull((yield* threads.getThreadShell(members[0]!))?.groupedUnderThreadId);
      assert.isEmpty((yield* threads.getThreadArchiveFamily(a)).childThreadIds);
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("organization:archive-former"),
        threadId: a,
      });
      assert.isNull((yield* threads.getThreadShell(members[1]!))?.archivedAt);
      assert.equal(
        (yield* service.listThreads(scope, { underThreadId: b, settled: false, limit: 100 })).total,
        119,
      );
      const sink = yield* EventSink.EventSinkV2;
      for (const [index, status] of (["stopping", "failed"] as const).entries()) {
        const threadId = members[index + 3]!;
        const original = yield* threads.getThreadProjection(threadId);
        const archivePending = {
          threadId,
          commandId: CommandId.make(`organization:pending-archive:${status}`),
          status,
          childDisposition: "stop_and_archive" as const,
          childThreadIds: [],
          archiveThreadIds: [threadId],
          promoteThreadIds: [],
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`organization:pending-archive:${status}`),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: original.thread.updatedAt,
              payload: { ...original.thread, archivePending },
            },
          ],
        });
        const item = {
          threadId,
          commandId: CommandId.make(`organization:release-pending:${status}`),
          groupedUnderThreadId: null,
        };
        const refused = yield* threads.setThreadParents({
          projectId: ProjectId.make("organization:wrong-project"),
          items: [item],
        });
        assert.equal(refused[0]?.status, "rejected");
        assert.equal((yield* threads.getThreadShell(threadId))?.groupedUnderThreadId, b);
        const released = yield* threads.setThreadParents({ projectId, items: [item] });
        assert.equal(released[0]?.status, "moved", status);
        assert.equal(released[0]?.previousGroupedUnderThreadId, b);
        const after = yield* threads.getThreadProjection(threadId);
        assert.isNull(after.thread.groupedUnderThreadId);
        assert.deepEqual(after.thread.archivePending, archivePending);
        assert.deepEqual(after.thread.lineage, original.thread.lineage);
        assert.equal(after.thread.creatorThreadId, original.thread.creatorThreadId);
        assert.deepEqual(after.messages, original.messages);
        assert.deepEqual(after.runs, original.runs);
        const retried = yield* threads.setThreadParents({ projectId, items: [item] });
        assert.isTrue(retried[0]?.replayed);
        assert.equal(retried[0]?.sequence, released[0]?.sequence);
      }
      const deleted = members[2]!;
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("organization:delete-moved"),
        threadId: deleted,
      });
      assert.isNull(yield* threads.getThreadShell(deleted));
      const afterDelete = yield* threads.setThreadParents({ projectId, items });
      assert.isTrue(
        afterDelete.every(
          (item, index) =>
            item.status === "moved" && item.replayed && item.sequence === moved[index]!.sequence,
        ),
      );
      const wrongProject = yield* threads.setThreadParents({
        projectId: ProjectId.make("wrong-project"),
        items,
      });
      assert.equal(wrongProject[0]?.status, "rejected");
    }).pipe(Effect.provide(layer)),
);

it.effect("retries an interrupted MCP create with a prompt after reopening its target", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const { requests } = yield* createParent;
    const input = {
      clientRequestId: "interrupted-create",
      threads: [{ title: "Child", prompt: "Inspect the change" }],
    };
    const created = yield* Deferred.make<{ commandId: CommandId; threadId: ThreadId }>();
    const dispatchLaunch = threads.dispatchLaunch;
    const spy = vi.spyOn(threads, "dispatchLaunch").mockImplementation((input) =>
      input.claim.type === "thread.create"
        ? threads.dispatch({ ...input.claim, initialMessage: undefined }).pipe(
            Effect.tap(() => Deferred.succeed(created, input.claim)),
            Effect.andThen(Effect.never),
          )
        : dispatchLaunch(input),
    );
    yield* Effect.gen(function* () {
      const creating = yield* service.createThreads(scope, input).pipe(Effect.forkChild());
      const claim = yield* Deferred.await(created);
      yield* Fiber.interrupt(creating);
      spy.mockRestore();
      const threadId = claim.threadId;
      const messageCommandId = CommandId.make(
        String(claim.commandId).replace("create-thread", "dispatch-thread"),
      );
      assert.equal(
        Option.getOrThrow(yield* receipts.getByCommandId(claim.commandId)).status,
        "accepted",
      );
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-created-target"),
        threadId,
      });
      const refused = yield* service.createThreads(scope, input).pipe(Effect.flip);
      assert.equal(refused.code, "orchestration_error");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(messageCommandId)));
      assert.isEmpty((yield* threads.getThreadProjection(threadId)).messages);
      yield* threads.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen-created-target"),
        threadId,
      });
      const retried = yield* service.createThreads(scope, input);
      assert.equal(retried.threads[0]?.threadId, threadId);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.lengthOf(projection.messages, 1);
      assert.equal(projection.messages[0]?.senderThreadId, parentThreadId);
      assert.equal(projection.messages[0]?.text, input.threads[0]?.prompt);
      assert.equal(projection.thread.createdBy, "agent");
      assert.equal(projection.thread.creationSource, "mcp");
      assert.equal(projection.thread.creatorThreadId, parentThreadId);
      assert.equal(projection.thread.branch, "feature");
      assert.equal(projection.thread.worktreePath, "/repo-worktree");
      assert.lengthOf(projection.runs, 1);
      yield* Effect.gen(function* () {
        const broker = yield* ThreadReadBroker.ThreadReadBroker;
        const reading = yield* broker
          .read(threadId, projection.runs[0]!.id, {
            threadId: ThreadId.make("thread:remote-target"),
          })
          .pipe(Effect.flip, Effect.forkChild());
        const request = Option.getOrThrow(
          yield* Effect.raceFirst(
            Stream.runHead(requests),
            Fiber.join(reading).pipe(
              Effect.andThen(Effect.die("Created thread lost the caller's read authorization.")),
            ),
          ),
        );
        yield* broker.respond("client:mcp-create", {
          connectionId: request.connectionId,
          requestId: request.requestId,
          result: null,
          unavailableEnvironmentIds: [],
        });
        assert.equal((yield* Fiber.join(reading)).code, "thread_not_found");
      }).pipe(Effect.scoped);
      assert.equal(
        Option.getOrThrow(yield* receipts.getByCommandId(messageCommandId)).status,
        "accepted",
      );
      yield* service.createThreads(scope, input);
      assert.lengthOf((yield* threads.getThreadProjection(threadId)).messages, 1);
    }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts an MCP prompt before a concurrent archive can take its target", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    yield* createParent;
    const created = yield* Deferred.make<ThreadId>();
    const allowMessage = yield* Deferred.make<void>();
    const archiveQueued = yield* Deferred.make<void>();
    const commitCommand = sink.commitCommand;
    const commitSpy = vi.spyOn(sink, "commitCommand").mockImplementation((command) =>
      command.commandType === "thread.create"
        ? commitCommand(command).pipe(
            Effect.tap(() => Deferred.succeed(created, command.threadId)),
            Effect.tap(() => Deferred.await(allowMessage)),
          )
        : commitCommand(command),
    );
    yield* Effect.gen(function* () {
      const creating = yield* service
        .createThreads(scope, {
          clientRequestId: "concurrent-create",
          threads: [{ prompt: "Accept before archive" }],
        })
        .pipe(Effect.forkChild());
      const threadId = yield* Deferred.await(created);
      const accepted = yield* threads.getThreadProjection(threadId);
      assert.lengthOf(accepted.messages, 1);
      assert.lengthOf(accepted.runs, 1);
      // The archive planner captures its lock ports before this test starts.
      const archiveTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          if (span.name === "ThreadCommandExecutor.withPersistenceLock")
            Deferred.doneUnsafe(archiveQueued, Effect.void);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const archiving = yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive-concurrent-create"),
            threadId,
          })
          .pipe(
            Effect.flip,
            Effect.withTracer(archiveTracer),
            Effect.withTracerEnabled(true),
            Effect.forkChild(),
          );
        yield* Effect.raceFirst(
          Deferred.await(archiveQueued),
          Fiber.join(archiving).pipe(
            Effect.andThen(Effect.die("Archive bypassed MCP prompt acceptance.")),
          ),
        );
        assert.isNull((yield* threads.getThreadProjection(threadId)).thread.archivedAt);
        yield* Deferred.succeed(allowMessage, undefined);
        const result = yield* Fiber.join(creating);
        assert.equal(result.threads[0]?.threadId, threadId);
        yield* Fiber.join(archiving);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.lengthOf(projection.messages, 1);
        assert.isNull(projection.thread.archivedAt);
      });
    }).pipe(Effect.ensuring(Effect.sync(() => commitSpy.mockRestore())));
  }).pipe(Effect.provide(layer)),
);

it.effect("creates and replays an idle MCP thread without a prompt", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* createParent;
    const input = { clientRequestId: "idle-create", threads: [{ title: "Later" }] };
    const created = yield* service.createThreads(scope, input);
    const replayed = yield* service.createThreads(scope, input);
    assert.deepEqual(replayed, created);
    const result = created.threads[0]!;
    assert.equal(result.status, "idle");
    assert.isNull(result.runId);
    const projection = yield* threads.getThreadProjection(result.threadId);
    assert.isEmpty(projection.messages);
    assert.isEmpty(projection.runs);
    const sink = yield* EventSink.EventSinkV2;
    const parent = yield* threads.getThreadProjection(parentThreadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("failed-parent-archive"),
          type: "thread.metadata-updated",
          threadId: parentThreadId,
          occurredAt: parent.thread.updatedAt,
          payload: {
            ...parent.thread,
            archivePending: {
              threadId: parentThreadId,
              commandId: CommandId.make("failed-parent-archive"),
              status: "failed",
              childDisposition: "stop_and_archive",
              childThreadIds: [],
              archiveThreadIds: [parentThreadId],
              promoteThreadIds: [],
            },
          },
        },
      ],
    });
    const fromFailedParent = yield* service.createThreads(scope, {
      clientRequestId: "failed-parent-create",
      threads: [{ title: "Continue work" }],
    });
    assert.equal(fromFailedParent.threads[0]?.groupedUnderThreadId, parentThreadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("side-chat-parent"),
          type: "thread.metadata-updated",
          threadId: parentThreadId,
          occurredAt: parent.thread.updatedAt,
          payload: {
            ...parent.thread,
            lineage: { ...parent.thread.lineage, relationshipToParent: "fork", sideChat: true },
          },
        },
      ],
    });
    const fromSideChat = yield* service.createThreads(scope, {
      clientRequestId: "side-chat-create",
      threads: [{ title: "Visible notes" }],
    });
    assert.isNull(fromSideChat.threads[0]?.groupedUnderThreadId);
  }).pipe(Effect.provide(layer)),
);
