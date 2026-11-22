import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { dispatchUserCommand } from "../orchestration-v2/ThreadMessageIntake.ts";
import { ThreadReadAuthorization } from "../orchestration-v2/ThreadReadAuthorization.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeOriginalReferenceCheck } from "../mcp/ThreadReadOriginalReference.ts";
import { matchAcceptedInput } from "./Admission.ts";
import * as Store from "./Store.ts";
import type { ThreadReadIntakeIntent } from "./Types.ts";

const threadId = ThreadId.make("admission-thread");
const commandId = CommandId.make("command");
const messageId = MessageId.make("message");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe(0);
const reference: ThreadContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("attached-reference"),
  kind: "thread",
  label: "Reference",
  title: "Reference",
  environmentId: EnvironmentId.make("source-environment"),
  threadId: ThreadId.make("source-thread"),
};
const referenceText = "Read [Reference](t3-context://v1/thread/attached-reference).";
const message = (
  id = messageId,
  authorizationId?: MessageId,
  ownerRunId = RunId.make("run"),
): Extract<OrchestrationV2DomainEvent, { type: "message.updated" }> => ({
  id: EventId.make(`message-event:${id}`),
  type: "message.updated",
  threadId,
  occurredAt: now,
  payload: {
    id,
    threadId,
    role: "user",
    runId: ownerRunId,
    nodeId: null,
    text: "input",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    creationSource: "web",
    ...(authorizationId === undefined
      ? {}
      : { threadReadContext: { authorizationId, capturedAt: 0 } }),
  } satisfies OrchestrationV2ConversationMessage,
});
const referencedMessage = (...args: Parameters<typeof message>): ReturnType<typeof message> => {
  const event = message(...args);
  return {
    ...event,
    payload: {
      ...event.payload,
      text: referenceText,
      context: { version: 1, records: [reference] },
    },
  };
};
const run = (
  id = RunId.make("run"),
  userMessageId = messageId,
): Extract<OrchestrationV2DomainEvent, { type: "run.created" }> => ({
  id: EventId.make(`run-event:${id}`),
  type: "run.created",
  threadId,
  occurredAt: now,
  payload: {
    id,
    threadId,
    userMessageId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "model" },
    providerThreadId: null,
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run,
});
const request = (
  authorizationId?: MessageId,
): Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }> => ({
  id: EventId.make("answer-event"),
  type: "runtime-request.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: RuntimeRequestId.make("question"),
    nodeId: NodeId.make("node"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "resolved",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: now,
    ...(authorizationId === undefined
      ? {}
      : { threadReadContext: { authorizationId, records: [] } }),
  },
});
const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);
const intent = Effect.fn("admissionFixture.intent")(function* (
  sessionId: string,
  inputId = messageId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at)
    VALUES (${sessionId}, ${sessionId}, '["orchestration:read"]', 'browser-session-cookie', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;
  const store = yield* Store.make;
  const authority = (yield* store.captureAuthenticatedSessionAuthority(sessionId))!;
  return Object.freeze({ threadId, inputId, authority }) satisfies ThreadReadIntakeIntent;
});
const input = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  threadReadIntent?: ThreadReadIntakeIntent,
  commandType = "message.dispatch",
) => ({
  threadId,
  commandId,
  commandType,
  events,
  effects: [],
  acceptedAt: now,
  ...(threadReadIntent === undefined ? {} : { threadReadIntent }),
});

it.each([
  ["message.dispatch", true],
  ["thread.create", true],
  ["thread.metadata.update", true],
  ["queued-run.promote", false],
] as const)(
  "matches %s without attaching authority to queue promotion",
  (commandType, accepted) => {
    const match = matchAcceptedInput(
      input([run(), message(messageId, messageId)], undefined, commandType),
      MessageId.make("nonce"),
    );
    assert.deepEqual(match.generalRunIds, accepted ? ["run"] : []);
    assert.equal(match.reference, accepted);
    assert.equal(
      (match.events[1] as ReturnType<typeof message>).payload.threadReadContext!.authorizationId,
      accepted ? "nonce" : messageId,
    );
  },
);

it.each(["message.dispatch", "thread.create", "thread.metadata.update"])(
  "synthesizes original reference metadata from an ordinary accepted %s event",
  (commandType) => {
    const original = referencedMessage();
    const createdAt = DateTime.makeUnsafe(1234);
    const accepted = { ...original, payload: { ...original.payload, createdAt } };
    const matched = matchAcceptedInput(
      input([run(), accepted], undefined, commandType),
      MessageId.make("nonce"),
    );
    assert.isTrue(matched.reference);
    assert.equal(matched.referenceId, "nonce");
    assert.deepEqual(matched.generalRunIds, ["run"]);
    assert.deepEqual((matched.events[1] as ReturnType<typeof message>).payload.threadReadContext, {
      authorizationId: "nonce",
      capturedAt: 1234,
    });
    assert.isUndefined(accepted.payload.threadReadContext);
  },
);

it.each([
  ["plain input", "input", undefined],
  ["unattached text", referenceText, undefined],
  ["unused record", "input", { version: 1, records: [reference] }],
  [
    "different reference",
    "[Other](t3-context://v1/thread/other)",
    { version: 1, records: [reference] },
  ],
] as const)("keeps general admission independent of %s", (_label, text, context) => {
  const event = message();
  const match = matchAcceptedInput(
    input([run(), { ...event, payload: { ...event.payload, text, context } }]),
    MessageId.make("nonce"),
  );
  assert.deepEqual(match.generalRunIds, ["run"]);
  assert.isFalse(match.reference);
  assert.isUndefined(match.referenceId);
  assert.isUndefined((match.events[1] as ReturnType<typeof message>).payload.threadReadContext);
});

it("matches async answers without references, and separates live answers and queued edits from general authority", () => {
  const answerId = MessageId.make("answer-context:command");
  const asyncId = MessageId.make("async-answer:question");
  const async = matchAcceptedInput(
    input(
      [
        request(),
        run(RunId.make("answer-run"), asyncId),
        message(asyncId, undefined, RunId.make("answer-run")),
      ],
      undefined,
      "runtime-request.respond",
    ),
    MessageId.make("nonce"),
  );
  assert.equal(async.expectedId, answerId);
  assert.deepEqual(async.generalRunIds, ["answer-run"]);
  assert.isFalse(async.reference);
  const live = matchAcceptedInput(
    input([request(answerId)], undefined, "runtime-request.respond"),
    MessageId.make("nonce"),
  );
  assert.isTrue(live.reference);
  assert.deepEqual(live.generalRunIds, []);
  const edit = matchAcceptedInput(
    input(
      [message(messageId, MessageId.make("queued-edit-context:command"))],
      undefined,
      "queued-run.edit",
    ),
    MessageId.make("nonce"),
  );
  assert.isTrue(edit.reference);
  assert.deepEqual(edit.generalRunIds, []);
});

it.effect.each([false, true])(
  "commits immutable run authority and a separate server nonce; receipt replay and retry never take ownership (metadata: %s)",
  (withMetadata) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Store.make;
      const original = yield* intent("A");
      const other = yield* intent("B");
      const originalMessage = withMetadata ? message(messageId, messageId) : referencedMessage();
      const events = [run(), originalMessage];
      const committed = yield* sink.commitCommand(input(events, original));
      assert.isTrue(committed.committed);
      const acceptedMessage = committed.storedEvents.find(
        ({ event }) => event.type === "message.updated",
      )!.event;
      assert.equal(acceptedMessage.type, "message.updated");
      if (acceptedMessage.type !== "message.updated") return;
      const nonce = acceptedMessage.payload.threadReadContext!.authorizationId;
      assert.notEqual(nonce, messageId);
      assert.match(nonce, /^read-reference:/);
      assert.equal(acceptedMessage.payload.threadReadContext!.capturedAt, 0);
      assert.equal(
        originalMessage.payload.threadReadContext?.authorizationId,
        withMetadata ? messageId : undefined,
      );
      assert.isTrue(yield* (yield* makeOriginalReferenceCheck)(threadId, RunId.make("run"), nonce));
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.sessionId, "A");
      assert.equal((yield* store.lookupGrant(threadId, "reference", nonce))!.sessionId, "A");
      const replay = yield* sink.commitCommand(input(events, other));
      assert.isFalse(replay.committed);
      assert.deepEqual(replay.storedEvents, committed.storedEvents);
      yield* sql`DELETE FROM lastcode_thread_read_grants`;
      yield* sink.commitCommand(input(events, other));
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
      const retried = yield* sink.commitCommand({
        ...input([{ ...originalMessage, id: EventId.make("retry-input-event") }], other),
        commandId: CommandId.make("new-command"),
      });
      const retriedMessage = retried.storedEvents[0]!.event;
      assert.equal(retriedMessage.type, "message.updated");
      if (retriedMessage.type === "message.updated")
        assert.isUndefined(
          yield* store.lookupGrant(
            threadId,
            "reference",
            retriedMessage.payload.threadReadContext!.authorizationId,
          ),
        );
    }).pipe(Effect.provide(layer)),
);

it.effect.each([false, true])(
  "leaves denied overrides inert and never grants unaccepted inputs; SQL failure rolls ownership and receipt back for retry (metadata: %s)",
  (withMetadata) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Store.make;
      const pending = yield* intent("pending");
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
      yield* sql`UPDATE auth_sessions SET revoked_at = 'revoked' WHERE session_id = 'pending'`;
      const denied = yield* sink.commitCommand(
        input([run(), withMetadata ? message(messageId, messageId) : referencedMessage()], pending),
      );
      const deniedMessage = denied.storedEvents.find(
        ({ event }) => event.type === "message.updated",
      )!.event;
      if (deniedMessage.type === "message.updated") {
        const nonce = deniedMessage.payload.threadReadContext!.authorizationId;
        assert.notEqual(nonce, messageId);
        assert.isUndefined(yield* store.lookupGrant(threadId, "reference", nonce));
      }
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "run"));
      const nextId = MessageId.make("next-input");
      const next = yield* intent("next", nextId);
      const nextRun = {
        ...run(RunId.make("next-run"), nextId),
        payload: { ...run(RunId.make("next-run"), nextId).payload, ordinal: 2 },
      };
      const attempt = {
        ...input(
          [
            nextRun,
            withMetadata
              ? message(nextId, nextId, nextRun.payload.id)
              : referencedMessage(nextId, undefined, nextRun.payload.id),
          ],
          next,
        ),
        commandId: CommandId.make("retry"),
      };
      yield* sql`CREATE TRIGGER fail_authority BEFORE INSERT ON lastcode_thread_read_grants BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      yield* sink.commitCommand(attempt).pipe(Effect.flip);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_command_receipts WHERE command_id = 'retry'`,
        [],
      );
      assert.isUndefined(yield* store.lookupGrant(threadId, "run", "next-run"));
      yield* sql`DROP TRIGGER fail_authority`;
      assert.isTrue((yield* sink.commitCommand(attempt)).committed);
      assert.equal((yield* store.lookupGrant(threadId, "run", "next-run"))!.sessionId, "next");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps the original queued run owner through a cross-session edit and live exact answer",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Store.make;
      const original = yield* intent("original");
      yield* sink.commitCommand(input([run(), message()], original));
      const editor = yield* intent("editor", MessageId.make("queued-edit-context:edit"));
      const edited = yield* sink.commitCommand({
        ...input(
          [{ ...message(messageId, editor.inputId), id: EventId.make("edit-event") }],
          editor,
          "queued-run.edit",
        ),
        commandId: CommandId.make("edit"),
      });
      const editedMessage = edited.storedEvents[0]!.event;
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.sessionId, "original");
      if (editedMessage.type === "message.updated")
        assert.equal(
          (yield* store.lookupGrant(
            threadId,
            "reference",
            editedMessage.payload.threadReadContext!.authorizationId,
          ))!.sessionId,
          "editor",
        );
      const noReferenceEdit = yield* intent(
        "plain-editor",
        MessageId.make("queued-edit-context:plain-edit"),
      );
      yield* sink.commitCommand({
        ...input(
          [{ ...message(), id: EventId.make("plain-edit-event") }],
          noReferenceEdit,
          "queued-run.edit",
        ),
        commandId: CommandId.make("plain-edit"),
      });
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.sessionId, "original");
      const answerer = yield* intent("answerer", MessageId.make("answer-context:answer"));
      const answered = yield* sink.commitCommand({
        ...input([request(answerer.inputId)], answerer, "runtime-request.respond"),
        commandId: CommandId.make("answer"),
      });
      const answeredRequest = answered.storedEvents[0]!.event;
      if (answeredRequest.type === "runtime-request.updated")
        assert.equal(
          (yield* store.lookupGrant(
            threadId,
            "reference",
            answeredRequest.payload.threadReadContext!.authorizationId,
          ))!.sessionId,
          "answerer",
        );
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.sessionId, "original");
    }).pipe(Effect.provide(layer)),
);

it.effect.each([false, true])(
  "persists only accepted denial reasons without source identity or ambient authority (metadata: %s)",
  (withMetadata) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Store.make;
      yield* intent("ambient");
      const denied = Object.freeze({
        threadId,
        inputId: messageId,
        denialReason: "reauth-required" as const,
      });
      const accepted = yield* sink.commitCommand(
        input([run(), withMetadata ? message(messageId, messageId) : referencedMessage()], denied),
      );
      const acceptedMessage = accepted.storedEvents.find(
        ({ event }) => event.type === "message.updated",
      )!.event;
      assert.equal(yield* store.lookupFailureReason(threadId, "run", "run"), "reauth-required");
      if (acceptedMessage.type === "message.updated") {
        const nonce = acceptedMessage.payload.threadReadContext!.authorizationId;
        assert.notEqual(nonce, messageId);
        assert.equal(
          yield* store.lookupFailureReason(threadId, "reference", nonce),
          "reauth-required",
        );
        assert.isUndefined(yield* store.lookupGrant(threadId, "reference", nonce));
      }
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
      assert.isUndefined(yield* store.lookupFailureReason(threadId, "run", "legacy-unknown"));
      const deniedRows = yield* sql`SELECT * FROM lastcode_thread_read_failures`;
      assert.isFalse(deniedRows.some((row) => "session_id" in row || "scopes" in row));
      yield* sql`DROP TRIGGER lastcode_thread_read_device_delete`;
      assert.equal(
        yield* store.lookupFailureReason(threadId, "run", "legacy-unknown"),
        "fence-unavailable",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["thread.create", "thread.metadata.update"])(
  "binds the initial queued launch in the %s commit",
  (commandType) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* Store.make;
      const initial = yield* intent("launcher");
      const accepted = yield* sink.commitCommand(input([run(), message()], initial, commandType));
      assert.isTrue(accepted.committed);
      assert.equal((yield* store.lookupGrant(threadId, "run", "run"))!.sessionId, "launcher");
    }).pipe(Effect.provide(layer)),
);

it.effect("binds an accepted async answer's general authority without any attached reference", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* Store.make;
    const answering = yield* intent("answering", MessageId.make("answer-context:command"));
    const answerId = MessageId.make("async-answer:question");
    yield* sink.commitCommand(
      input(
        [
          request(),
          run(RunId.make("answer-run"), answerId),
          message(answerId, undefined, RunId.make("answer-run")),
        ],
        answering,
        "runtime-request.respond",
      ),
    );
    assert.equal((yield* store.lookupGrant(threadId, "run", "answer-run"))!.sessionId, "answering");
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["missing", "wrong-input", "wrong-thread", "unaccepted"] as const)(
  "keeps ordinary attached references inert with %s admission intent",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const ambient = yield* intent("ambient");
      const supplied =
        kind === "missing"
          ? undefined
          : kind === "wrong-input"
            ? { ...ambient, inputId: MessageId.make("another-input") }
            : kind === "wrong-thread"
              ? { ...ambient, threadId: ThreadId.make("another-thread") }
              : ambient;
      if (kind === "unaccepted") {
        yield* sink.commitRejectedCommand({
          threadId,
          commandId,
          commandType: "message.dispatch",
          rejectedAt: now,
          error: "input was rejected",
        });
        yield* sink.commitCommand(input([run(), referencedMessage()], supplied)).pipe(Effect.exit);
        assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
        return;
      }
      const accepted = yield* sink.commitCommand(input([run(), referencedMessage()], supplied));
      assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
      const event = accepted.storedEvents.find(
        ({ event }) => event.type === "message.updated",
      )!.event;
      assert.equal(event.type, "message.updated");
      if (event.type === "message.updated") {
        assert.match(event.payload.threadReadContext!.authorizationId, /^read-reference:/);
        assert.equal(event.payload.threadReadContext!.capturedAt, 0);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["intake", "intake-create", "thread.create", "thread.metadata.update"] as const)(
  "admits ordinary attached references through real %s without caller metadata",
  (path) => {
    const registry = ProviderAdapterRegistry.layerSingle({
      instanceId: providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("provider execution is disabled in admission tests"),
    } satisfies ProviderAdapter.ProviderAdapterV2["Service"]);
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "reference-admission" },
      registry,
      {
        databaseLayer: Sqlite.layerMemory,
        runEffectWorker: false,
      },
    );
    const realLayer = ThreadManagement.layer.pipe(
      Layer.provideMerge(runtime),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "reference-admission-intake-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(Layer.mock(DocumentText.DocumentText)({})),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* Store.make;
      const original = yield* intent("submitter");
      const claim = {
        type: "thread.create" as const,
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("admission-project"),
        title: "Reference admission",
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      const command = {
        type: "message.dispatch" as const,
        commandId,
        threadId,
        messageId,
        text: referenceText,
        context: { version: 1 as const, records: [reference] },
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      if (path !== "thread.create" && path !== "intake-create") yield* orchestrator.dispatch(claim);
      const accepted =
        path === "intake" || path === "intake-create"
          ? yield* dispatchUserCommand(
              path === "intake"
                ? command
                : {
                    ...claim,
                    initialMessage: {
                      messageId,
                      text: command.text,
                      context: command.context,
                      attachments: [],
                      workspaceStrategy: { type: "root" },
                    },
                  },
            ).pipe(
              Effect.provideService(ThreadReadAuthorization, {
                authorize: (targetThreadId, targetMessageId) => {
                  assert.equal(targetThreadId, threadId);
                  assert.equal(targetMessageId, messageId);
                  return Effect.succeed(original);
                },
              }),
            )
          : (yield* orchestrator.dispatchLaunch({
              claim:
                path === "thread.create"
                  ? {
                      ...claim,
                      initialMessage: {
                        messageId,
                        text: command.text,
                        context: command.context,
                        attachments: [],
                        workspaceStrategy: { type: "root" },
                      },
                    }
                  : {
                      type: "thread.metadata.update",
                      commandId: CommandId.make("reuse-thread"),
                      threadId,
                      expectedEmpty: true,
                    },
              initialMessage: {
                ...command,
                dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
              },
              threadReadIntent: original,
            })).initialMessage;
      const event = accepted.storedEvents.find(
        ({ event }) => event.type === "message.updated",
      )!.event;
      assert.equal(event.type, "message.updated");
      if (event.type !== "message.updated") return;
      const metadata = event.payload.threadReadContext!;
      assert.match(metadata.authorizationId, /^read-reference:/);
      assert.notEqual(metadata.authorizationId, messageId);
      assert.equal(metadata.capturedAt, DateTime.toEpochMillis(event.payload.createdAt));
      assert.deepEqual(event.payload.context, command.context);
      assert.equal(
        (yield* store.lookupGrant(threadId, "run", event.payload.runId!))!.sessionId,
        "submitter",
      );
      assert.equal(
        (yield* store.lookupGrant(threadId, "reference", metadata.authorizationId))!.sessionId,
        "submitter",
      );
      const isOriginal = yield* makeOriginalReferenceCheck;
      assert.isTrue(yield* isOriginal(threadId, event.payload.runId!, metadata.authorizationId));
    }).pipe(Effect.provide(realLayer));
  },
);
