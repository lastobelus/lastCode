import { describe, expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  type ActionResumeOwner,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  ProjectionRecordField,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { resolveThreadReadContinuation } from "./ThreadReadContinuation.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const target = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("target"),
};
const instance = ProviderInstanceId.make("codex");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const reference: ThreadContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("attached"),
  kind: "thread",
  label: "Reference",
  title: "Reference",
  ...target,
};
const referenceText = "[Reference](t3-context://v1/thread/attached)";

const run = (
  id: string,
  ordinal: number,
  requestedAt: number,
  extra: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: threadA,
  ordinal,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "test-model" },
  providerThreadId: null,
  userMessageId: MessageId.make(`input:${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at(requestedAt),
  startedAt: at(requestedAt),
  completedAt: at(requestedAt),
  checkpointId: null,
  contextHandoffId: null,
  ...extra,
});

const message = (
  source: OrchestrationV2Run,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  id: source.userMessageId,
  threadId: source.threadId,
  runId: source.id,
  nodeId: null,
  role: "user",
  text: "Input",
  createdBy: "user",
  creationSource: "web",
  attachments: [],
  streaming: false,
  createdAt: source.requestedAt,
  updatedAt: source.requestedAt,
  ...extra,
});

const attached = (
  source: OrchestrationV2Run,
  nonce: string,
  capturedAt = DateTime.toEpochMillis(source.requestedAt),
  extra: Partial<OrchestrationV2ConversationMessage> = {},
) =>
  message(source, {
    text: referenceText,
    context: { version: 1, records: [reference] },
    threadReadContext: { authorizationId: MessageId.make(nonce), capturedAt },
    ...extra,
  });

const completion = (source: OrchestrationV2Run, wake: OrchestrationV2Run) =>
  message(wake, {
    createdBy: "agent",
    creationSource: "server",
    delegatedCompletion: { parentRunId: source.id, generation: 1, taskIds: [NodeId.make("task")] },
  });

const owner = (source: OrchestrationV2Run): ActionResumeOwner => ({
  parentEnvironmentId: EnvironmentId.make("environment-a"),
  parentThreadId: threadB,
  taskId: NodeId.make("task"),
  sourceRunId: source.id,
  delegationId: "delegation",
});

const spawn = (
  source: OrchestrationV2Run,
  child: OrchestrationV2Run,
  createdAt: number,
  extra: Partial<OrchestrationV2ContextTransfer> = {},
): OrchestrationV2ContextTransfer => ({
  id: ContextTransferId.make(`spawn:${source.threadId}:${source.id}`),
  type: "subagent_spawn",
  sourceThreadId: source.threadId,
  targetThreadId: child.threadId,
  sourcePoint: { threadId: source.threadId, runId: source.id },
  basePoint: null,
  sourceProviderInstanceId: instance,
  targetProviderInstanceId: instance,
  targetRunId: child.id,
  status: "consumed",
  resolution: null,
  createdBy: "agent",
  error: null,
  createdAt: at(createdAt),
  updatedAt: at(createdAt),
  consumedAt: at(createdAt),
  ...extra,
});

const node = (source: OrchestrationV2Run): OrchestrationV2ExecutionNode => ({
  id: NodeId.make(`node:${source.threadId}:${source.id}`),
  threadId: source.threadId,
  runId: source.id,
  parentNodeId: null,
  rootNodeId: NodeId.make(`node:${source.threadId}:${source.id}`),
  kind: "root_turn",
  status: "completed",
  countsForRun: true,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: source.requestedAt,
  completedAt: source.requestedAt,
});

const answer = (
  source: OrchestrationV2Run,
  id: string,
  resolvedAt: number,
  nonce: string,
  extra: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: node(source).id,
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "resolved",
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
  createdAt: source.requestedAt,
  resolvedAt: at(resolvedAt),
  threadReadContext: { authorizationId: MessageId.make(nonce), records: [reference] },
  ...extra,
});

const provider = (source: OrchestrationV2Run): OrchestrationV2ProviderThread => ({
  id: source.providerThreadId!,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: source.providerInstanceId,
  providerSessionId: ProviderSessionId.make("session"),
  appThreadId: source.threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: source.ordinal,
  lastRunOrdinal: source.ordinal,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: source.requestedAt,
  updatedAt: source.requestedAt,
});

const makeHarness = (...runs: OrchestrationV2Run[]) => {
  const messages = runs.map((source) => message(source));
  const transfers: OrchestrationV2ContextTransfer[] = [];
  const requests: OrchestrationV2RuntimeRequest[] = [];
  const nodes = runs.map(node);
  const providers: OrchestrationV2ProviderThread[] = [];
  const grants = new Map<string, string>();
  const originals = new Set<string>();
  const lookups: string[] = [];
  const loads: Array<{ threadId: ThreadId; fields: ReadonlyArray<ProjectionRecordField> }> = [];
  const key = (kind: string, threadId: ThreadId, id: string) =>
    JSON.stringify([kind, threadId, id]);
  const bind = (kind: "run" | "reference", source: OrchestrationV2Run, id: string, grant: string) =>
    grants.set(key(kind, source.threadId, id), grant);
  const getThreadRecords: ThreadManagementServiceShape["getThreadRecords"] = (id, fields, filter) =>
    Effect.sync(() => {
      loads.push({ threadId: id, fields });
      // These are SQL's AND selectors, not a projection-wide mock that ignores filters.
      const rows = {
        thread: { id },
        runs: runs.filter(
          (row) => row.threadId === id && (!filter?.runIds || filter.runIds.includes(row.id)),
        ),
        messages: messages.filter(
          (row) =>
            row.threadId === id &&
            (!filter?.messageRunIds ||
              (row.runId !== null && filter.messageRunIds.includes(row.runId))) &&
            (!filter?.messageIds || filter.messageIds.includes(row.id)) &&
            (!filter?.messageRoles || filter.messageRoles.includes(row.role)),
        ),
        nodes: nodes.filter((row) => row.threadId === id),
        contextTransfers: transfers.filter((row) => row.targetThreadId === id),
        runtimeRequests: requests.filter((row) =>
          nodes.some((n) => n.id === row.nodeId && n.threadId === id),
        ),
        providerThreads: providers.filter((row) => row.appThreadId === id),
      };
      return Object.fromEntries(
        Object.entries(rows).filter(
          ([field]) => field === "thread" || fields.includes(field as never),
        ),
      ) as ProjectionRecords<(typeof fields)[number]>;
    });
  const lookup = (kind: "run" | "reference", id: ThreadId, grantId: string) =>
    Effect.sync(() => {
      const serialized = key(kind, id, grantId);
      lookups.push(serialized);
      return grants.get(serialized);
    });
  const resolve = (source: OrchestrationV2Run, exact = true) =>
    resolveThreadReadContinuation(
      {
        getThreadRecords,
        lookupRunGrant: (id, grantId) => lookup("run", id, grantId),
        lookupReferenceGrant: (id, grantId) => lookup("reference", id, grantId),
        isOriginalInputReference: (id, runId, nonce) =>
          Effect.sync(() => originals.has(JSON.stringify([id, runId, nonce]))),
      },
      { threadId: source.threadId, runId: source.id, ...(exact ? { reference: target } : {}) },
    );
  const setMessage = (source: OrchestrationV2Run, value: OrchestrationV2ConversationMessage) => {
    const index = messages.findIndex(
      (row) => row.threadId === source.threadId && row.id === source.userMessageId,
    );
    messages[index] = value;
  };
  return {
    runs,
    messages,
    transfers,
    requests,
    nodes,
    providers,
    grants,
    certifyOriginal: (source: OrchestrationV2Run, nonce: string) =>
      originals.add(JSON.stringify([source.threadId, source.id, nonce])),
    lookups,
    loads,
    bind,
    resolve,
    setMessage,
    getThreadRecords,
  };
};

describe("ThreadReadContinuation", () => {
  it.effect("uses only the captured run's accepted general grant across interleaved clients", () =>
    Effect.gen(function* () {
      const first = run("r1", 1, 10);
      const second = run("r2", 2, 10);
      const h = makeHarness(first, second);
      h.bind("run", first, first.id, "client-a");
      h.bind("run", second, second.id, "client-b");
      expect(yield* h.resolve(first)).toMatchObject({
        kind: "grant",
        grant: "client-a",
        key: { kind: "run", grantId: first.id },
      });
      h.grants.clear();
      h.bind("run", second, second.id, "client-b");
      expect(yield* h.resolve(first)).toBeUndefined();
      expect(yield* h.resolve(run("missing", 3, 20))).toBeUndefined();
    }),
  );

  it.effect("follows a new delegate completion through the exact server starting message", () =>
    Effect.gen(function* () {
      const first = run("r1", 1, 10);
      const other = run("interleaved", 2, 20);
      const wake = run("wake", 3, 30);
      const h = makeHarness(first, other, wake);
      h.setMessage(first, attached(first, "reference-a"));
      h.setMessage(wake, completion(first, wake));
      h.bind("run", first, first.id, "client-a");
      h.bind("run", other, other.id, "client-b");
      h.bind("reference", first, "reference-a", "reference-client");
      expect(yield* h.resolve(wake)).toMatchObject({
        grant: "reference-client",
        source: { threadId: threadA, runId: first.id },
        key: { grantId: "reference-a" },
      });
      expect(yield* h.resolve(wake, false)).toMatchObject({
        grant: "client-a",
        key: { kind: "run", grantId: first.id },
      });
    }),
  );

  it.effect(
    "a completion steered into R2 lends neither general nor reference authority from R1",
    () =>
      Effect.gen(function* () {
        const first = run("r1", 1, 10);
        const active = run("r2", 2, 20, { status: "running" });
        const queued = run("queued", 3, 30, { status: "cancelled" });
        const h = makeHarness(first, active, queued);
        h.setMessage(first, attached(first, "reference-a"));
        h.setMessage(queued, { ...completion(first, queued), runId: active.id });
        h.bind("run", first, first.id, "client-a");
        h.bind("reference", first, "reference-a", "client-a");
        h.bind("run", active, active.id, "client-b");
        expect(yield* h.resolve(active)).toMatchObject({
          grant: "client-b",
          key: { kind: "run", grantId: active.id },
        });
      }),
  );

  it.effect("matches only accepted references on this run's user messages and answers", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const other = run("other", 2, 10);
      const h = makeHarness(source, other);
      h.setMessage(source, attached(source, "original"));
      h.setMessage(other, attached(other, "other-client", 30));
      h.messages.push(
        attached(source, "assistant", 30, { id: MessageId.make("assistant"), role: "assistant" }),
        attached(source, "stale-context", 30, {
          id: MessageId.make("stale"),
          text: "No attachment",
        }),
        attached(source, "wrong-environment", 30, {
          id: MessageId.make("wrong-environment"),
          context: {
            version: 1,
            records: [{ ...reference, environmentId: EnvironmentId.make("elsewhere") }],
          },
        }),
      );
      h.requests.push(
        answer(other, "other-question", 30, "other-client"),
        answer(source, "pending", 30, "pending", { status: "pending" }),
        answer(source, "unresolved", 30, "unresolved", { resolvedAt: null }),
      );
      h.bind("reference", source, "original", "original-client");
      expect(yield* h.resolve(source)).toMatchObject({ grant: "original-client" });
    }),
  );

  it.effect.each([
    "restartContinuationOfRunId",
    "manualContinuationOfRunId",
    "usageLimitContinuationOfRunId",
  ] as const)("%s follows only an agent/server starting input", (pointer) =>
    Effect.gen(function* () {
      const first = run("source", 1, 10);
      const wake = run("wake", 2, 20, { [pointer]: first.id });
      const h = makeHarness(first, wake);
      h.bind("run", first, first.id, "original");
      h.bind("run", wake, wake.id, "new-client");
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "new-client" });
      h.grants.delete(JSON.stringify(["run", wake.threadId, wake.id]));
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.setMessage(wake, message(wake, { createdBy: "user", creationSource: "server" }));
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.setMessage(wake, message(wake, { createdBy: "agent", creationSource: "mcp" }));
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.setMessage(wake, message(wake, { createdBy: "agent", creationSource: "server" }));
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "original" });
    }),
  );

  it.effect("requires an exact start ID, valid completion marker and earlier source ordinal", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const wake = run("wake", 2, 20);
      const h = makeHarness(source, wake);
      h.bind("run", source, source.id, "client");
      const valid = completion(source, wake);
      for (const invalid of [
        { ...valid, id: MessageId.make("unrelated") },
        { ...valid, createdBy: "user" as const },
        { ...valid, creationSource: "mcp" as const },
        { ...valid, role: "assistant" as const },
        { ...valid, delegatedCompletion: { ...valid.delegatedCompletion!, generation: 0 } },
        {
          ...valid,
          delegatedCompletion: {
            ...valid.delegatedCompletion!,
            parentRunId: RunId.make("missing"),
          },
        },
        { ...valid, delegatedCompletion: { ...valid.delegatedCompletion!, parentRunId: wake.id } },
      ]) {
        h.messages.splice(1, 1, invalid);
        expect(yield* h.resolve(wake)).toBeUndefined();
      }
      h.messages.splice(1, 1, valid);
      for (const invalid of [
        { ...source, ordinal: wake.ordinal },
        { ...source, ordinal: wake.ordinal + 1 },
        { ...source, requestedAt: at(21) },
      ]) {
        h.runs[0] = invalid;
        expect(yield* h.resolve(wake)).toBeUndefined();
      }
      h.runs[0] = source;
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "client" });
    }),
  );

  it.effect("preserves intermediate exact overrides and denies an unbound matching nonce", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const middle = run("middle", 2, 20);
      const wake = run("wake", 3, 30);
      const h = makeHarness(source, middle, wake);
      h.setMessage(source, attached(source, "original"));
      h.setMessage(middle, {
        ...completion(source, middle),
        ...attached(middle, "override"),
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: completion(source, middle).delegatedCompletion,
      });
      h.setMessage(wake, completion(middle, wake));
      h.bind("run", source, source.id, "general");
      h.bind("reference", source, "original", "old-reference");
      expect(yield* h.resolve(wake)).toMatchObject({
        kind: "reference-denied",
        key: { grantId: "override" },
        source: { runId: middle.id },
      });
      h.bind("reference", middle, "override", "new-reference");
      expect(yield* h.resolve(wake)).toMatchObject({
        grant: "new-reference",
        key: { grantId: "override" },
      });
      expect(h.loads.filter((row) => row.fields.includes("runs"))).toHaveLength(2);
    }),
  );

  it.effect("keeps sender inheritance general-only even when an exact reference is denied", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const h = makeHarness(source);
      h.setMessage(source, attached(source, "unbound"));
      h.bind("run", source, source.id, "sender");
      expect(yield* h.resolve(source, false)).toMatchObject({
        grant: "sender",
        key: { kind: "run" },
      });
      expect(h.lookups).toEqual([JSON.stringify(["run", threadA, source.id])]);
      expect(yield* h.resolve(source)).toMatchObject({ kind: "reference-denied" });
    }),
  );

  it.effect("reads a moved queued start by ID while preserving one initial message per run", () =>
    Effect.gen(function* () {
      const active = run("active", 1, 10);
      const queued = run("queued", 2, 20, { status: "cancelled" });
      const h = makeHarness(active, queued);
      h.setMessage(queued, attached(queued, "editor", 25, { runId: active.id, updatedAt: at(25) }));
      h.bind("reference", queued, "editor", "editor");
      h.bind("run", active, active.id, "active-client");
      h.bind("run", queued, queued.id, "original-queued-client");
      expect(yield* h.resolve(queued)).toMatchObject({ grant: "editor" });
      expect(yield* h.resolve(active)).toMatchObject({ grant: "editor" });
      expect(yield* h.resolve(queued, false)).toMatchObject({ grant: "original-queued-client" });
      expect(yield* h.resolve(active, false)).toMatchObject({ grant: "active-client" });
      expect(new Set(h.messages.map((row) => row.id)).size).toBe(h.runs.length);
    }),
  );

  it.effect(
    "async answers start with the answerer's own general grant without attached context",
    () =>
      Effect.gen(function* () {
        const source = run("source", 1, 10);
        const request = answer(source, "question", 20, "answer", {
          responseCapability: { type: "message" },
          threadReadContext: undefined,
        });
        const resumed = run("answer", 2, 20, {
          userMessageId: MessageId.make(`async-answer:${request.id}`),
        });
        const h = makeHarness(source, resumed);
        h.requests.push(request);
        h.setMessage(resumed, message(resumed, { createdBy: "user", creationSource: "server" }));
        h.bind("run", source, source.id, "question-client");
        h.bind("run", resumed, resumed.id, "answer-client");
        expect(yield* h.resolve(resumed)).toMatchObject({
          grant: "answer-client",
          key: { grantId: resumed.id },
        });
      }),
  );

  it.effect(
    "live and async attached answers supply exact overrides without changing general grants",
    () =>
      Effect.gen(function* () {
        const source = run("source", 1, 10);
        const h = makeHarness(source);
        const request = answer(source, "question", 20, "answerer");
        h.requests.push(request);
        h.bind("run", source, source.id, "original");
        h.bind("reference", source, "answerer", "answerer");
        expect(yield* h.resolve(source)).toMatchObject({
          grant: "answerer",
          key: { kind: "reference" },
        });
        expect(yield* h.resolve(source, false)).toMatchObject({ grant: "original" });
        const resumed = run("answer", 2, 20, {
          userMessageId: MessageId.make(`async-answer:${request.id}`),
        });
        h.runs.push(resumed);
        h.messages.push(message(resumed, { createdBy: "user", creationSource: "server" }));
        h.requests[0] = { ...request, responseCapability: { type: "message" } };
        expect(yield* h.resolve(resumed)).toMatchObject({ grant: "answerer" });
        const wake = run("answer-wake", 3, 20);
        h.runs.push(wake);
        h.messages.push(completion(resumed, wake));
        h.certifyOriginal(resumed, "answerer");
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "answerer" });
      }),
  );

  it.effect(
    "excludes boundary/later answers while keeping eligible earlier and original overrides",
    () =>
      Effect.gen(function* () {
        const source = run("source", 1, 10);
        const wake = run("wake", 2, 20);
        const h = makeHarness(source, wake);
        h.setMessage(source, attached(source, "original"));
        h.setMessage(wake, completion(source, wake));
        h.bind("reference", source, "original", "original");
        h.bind("reference", source, "early", "early");
        h.bind("reference", source, "late", "late");
        h.requests.push(
          answer(source, "late-question", 21, "late"),
          answer(source, "boundary-question", 20, "unbound"),
        );
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "original" });
        h.requests.push(answer(source, "early-question", 19, "early"));
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "early" });
        expect(yield* h.resolve(source)).toMatchObject({ grant: "late" });
      }),
  );

  it.effect("does not infer order from opaque IDs when two answers have equal timestamps", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const h = makeHarness(source);
      h.requests.push(
        answer(source, "z-first", 20, "first"),
        answer(source, "a-second", 20, "second"),
      );
      h.bind("reference", source, "first", "client-a");
      h.bind("reference", source, "second", "client-b");
      h.bind("run", source, source.id, "general");
      expect(yield* h.resolve(source)).toEqual({
        kind: "reference-denied",
        source: { threadId: threadA, runId: source.id },
      });
    }),
  );

  it.effect("treats the immutable original input as preceding a same-tick continuation", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const wake = run("wake", 2, 10);
      const h = makeHarness(source, wake);
      h.setMessage(source, attached(source, "original"));
      h.setMessage(wake, completion(source, wake));
      h.bind("reference", source, "original", "original");
      h.bind("run", source, source.id, "original-client");
      h.certifyOriginal(source, "original");
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "original" });
      // A same-tick edit has the same createdAt, updatedAt and capturedAt. Only the
      // immutable admission witness distinguishes it from the captured original.
      h.setMessage(source, attached(source, "editor", 10));
      h.bind("reference", source, "editor", "editor");
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "original-client" });
    }),
  );

  it.effect(
    "excludes a starting message's queued edit captured at or after continuation capture",
    () =>
      Effect.gen(function* () {
        const source = run("source", 1, 10);
        const wake = run("wake", 2, 20);
        const h = makeHarness(source, wake);
        h.setMessage(wake, completion(source, wake));
        h.bind("run", source, source.id, "original-client");
        h.bind("reference", source, "editor", "editor");
        for (const capturedAt of [20, 21]) {
          h.setMessage(
            source,
            attached(source, "editor", capturedAt, { updatedAt: at(capturedAt) }),
          );
          expect(yield* h.resolve(wake)).toMatchObject({ grant: "original-client" });
        }
        h.setMessage(source, attached(source, "editor", 19, { updatedAt: at(19) }));
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "editor" });
      }),
  );

  it.effect("spawn uses its exact source point and the minimum cutoff across later hops", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const newer = run("newer", 2, 30);
      const child = run("child", 1, 25, { threadId: threadB });
      const wake = run("wake", 2, 40, { threadId: threadB });
      const h = makeHarness(source, newer, child, wake);
      h.transfers.push(spawn(source, child, 20));
      h.setMessage(source, attached(source, "original"));
      h.setMessage(wake, completion(child, wake));
      h.bind("run", newer, newer.id, "wrong-newer");
      h.bind("reference", source, "original", "original");
      h.bind("reference", source, "late", "late");
      h.requests.push(answer(source, "late", 20, "late"));
      expect(yield* h.resolve(wake)).toMatchObject({
        grant: "original",
        source: { threadId: threadA, runId: source.id },
      });
      expect(h.loads.filter((row) => row.fields.includes("runs"))).toHaveLength(2);
    }),
  );

  it.effect(
    "distinguishes identical opaque run IDs on different threads and closes actual cycles",
    () =>
      Effect.gen(function* () {
        const source = run("same-id", 1, 10);
        const child = run("same-id", 1, 20, { threadId: threadB });
        const h = makeHarness(source, child);
        h.transfers.push(spawn(source, child, 20));
        h.bind("run", source, source.id, "source");
        expect(yield* h.resolve(child)).toMatchObject({
          grant: "source",
          key: { threadId: threadA },
        });
        h.grants.clear();
        h.runs[0] = { ...source, requestedAt: at(20) };
        h.transfers.push(spawn(child, source, 20));
        expect(yield* h.resolve(child)).toBeUndefined();
        expect(h.loads.filter((row) => row.fields.includes("runs"))).toHaveLength(4);
      }),
  );

  it.effect("rejects missing, future, inconsistent, duplicate and unconsumed spawn sources", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const child = run("child", 1, 20, { threadId: threadB });
      const h = makeHarness(source, child);
      h.bind("run", source, source.id, "source");
      const valid = spawn(source, child, 20);
      for (const invalid of [
        { ...valid, sourcePoint: { threadId: threadA } },
        { ...valid, sourcePoint: { threadId: threadB, runId: source.id } },
        { ...valid, sourcePoint: { threadId: threadA, runId: RunId.make("missing") } },
        { ...valid, createdAt: at(9) },
        { ...valid, createdAt: at(21) },
        { ...valid, status: "pending" as const },
      ]) {
        h.transfers.splice(0, h.transfers.length, invalid);
        expect(yield* h.resolve(child)).toBeUndefined();
      }
      h.transfers.splice(0, h.transfers.length, valid, {
        ...valid,
        id: ContextTransferId.make("duplicate"),
      });
      expect(yield* h.resolve(child)).toBeUndefined();
    }),
  );

  it.effect("invalid or conflicting continuation markers cannot fall through to a spawn", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10);
      const earlierChild = run("earlier-child", 1, 10, { threadId: threadB });
      const child = run("child", 2, 20, { threadId: threadB });
      const h = makeHarness(source, earlierChild, child);
      h.transfers.push(spawn(source, child, 20));
      h.bind("run", source, source.id, "source");
      h.bind("run", earlierChild, earlierChild.id, "earlier-child");
      h.setMessage(child, completion(earlierChild, child));
      h.runs[2] = { ...child, manualContinuationOfRunId: RunId.make("different") };
      expect(yield* h.resolve(child)).toBeUndefined();
      h.runs[2] = child;
      h.setMessage(child, {
        ...completion(earlierChild, child),
        delegatedCompletion: { parentRunId: earlierChild.id, generation: 0, taskIds: [] },
      });
      expect(yield* h.resolve(child)).toBeUndefined();
      h.setMessage(child, completion(earlierChild, child));
      expect(yield* h.resolve(child)).toBeUndefined();
    }),
  );

  it.effect(
    "keeps Action and watch ownership exact, including watch generation and all owner fields",
    () =>
      Effect.gen(function* () {
        const source = run("source", 1, 10);
        const wake = run("wake", 2, 20);
        const h = makeHarness(source, wake);
        const ownership = owner(source);
        h.bind("run", source, source.id, "source");
        h.setMessage(wake, message(wake, { createdBy: "agent", creationSource: "server" }));
        const action = {
          actionRunId: "action",
          owner: ownership,
          messageId: wake.userMessageId,
          state: "transferred" as const,
          continuationRunId: wake.id,
        };
        h.runs[0] = { ...source, actionObligations: [action] };
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "source" });
        for (const invalid of [
          { ...action, messageId: MessageId.make("other") },
          { ...action, continuationRunId: RunId.make("other") },
          { ...action, owner: { ...ownership, sourceRunId: wake.id } },
          { ...action, state: "waiting" as const },
        ]) {
          h.runs[0] = { ...source, actionObligations: [invalid] };
          expect(yield* h.resolve(wake)).toBeUndefined();
        }
        const watch = { generation: "generation", owner: ownership, messageId: wake.userMessageId };
        const obligation = {
          generation: watch.generation,
          key: { host: "github.com", repository: "example/project", number: 1 },
          owner: ownership,
          sourceAttemptId: RunAttemptId.make("attempt"),
          state: "ended" as const,
        };
        h.runs[0] = { ...source, pullRequestWatchObligations: [obligation] };
        h.runs[1] = { ...wake, pullRequestWatchContinuation: watch };
        expect(yield* h.resolve(wake)).toMatchObject({ grant: "source" });
        for (const invalid of [
          { ...watch, generation: "other" },
          { ...watch, messageId: MessageId.make("other") },
          ...Object.keys(ownership).map((field) => ({
            ...watch,
            owner: { ...ownership, [field]: "other" } as ActionResumeOwner,
          })),
        ]) {
          h.runs[1] = { ...wake, pullRequestWatchContinuation: invalid };
          expect(yield* h.resolve(wake)).toBeUndefined();
        }
      }),
  );

  it.effect("background results require the accepted origin's provider-thread ownership", () =>
    Effect.gen(function* () {
      const source = run("source", 1, 10, { providerThreadId: ProviderThreadId.make("provider") });
      const wake = run("wake", 2, 20, {
        backgroundResultContinuation: {
          originRunId: source.id,
          providerThreadId: source.providerThreadId!,
          taskIds: ["background-task"],
        },
      });
      const h = makeHarness(source, wake);
      h.setMessage(wake, message(wake, { createdBy: "agent", creationSource: "provider" }));
      h.providers.push(provider(source));
      h.bind("run", source, source.id, "source");
      expect(yield* h.resolve(wake)).toMatchObject({ grant: "source" });
      h.providers[0] = { ...provider(source), ownerNodeId: NodeId.make("unrelated-owner") };
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.providers[0] = {
        ...provider(source),
        providerInstanceId: ProviderInstanceId.make("other"),
      };
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.providers[0] = provider(source);
      h.runs[0] = { ...source, providerThreadId: ProviderThreadId.make("other") };
      expect(yield* h.resolve(wake)).toBeUndefined();
      h.runs[0] = source;
      h.setMessage(wake, message(wake));
      expect(yield* h.resolve(wake)).toBeUndefined();
    }),
  );

  it.effect(
    "scheduled, ordinary callback, fresh and unknown origins have no ambient inheritance",
    () =>
      Effect.gen(function* () {
        const previous = run("previous", 1, 10);
        const fresh = run("fresh", 2, 20, { freshContext: true });
        const h = makeHarness(previous, fresh);
        h.bind("run", previous, previous.id, "previous-client");
        for (const trigger of [
          message(fresh),
          message(fresh, { createdBy: "agent", creationSource: "server" }),
          message(fresh, {
            createdBy: "agent",
            creationSource: "server",
            scheduledTaskId: ScheduledTaskId.make("scheduled"),
          }),
          message(fresh, { createdBy: "agent", creationSource: "mcp", senderThreadId: threadB }),
        ]) {
          h.setMessage(fresh, trigger);
          expect(yield* h.resolve(fresh)).toBeUndefined();
        }
        const result = yield* resolveThreadReadContinuation(
          {
            getThreadRecords: h.getThreadRecords,
            lookupRunGrant: () => Effect.succeed("wrong"),
            lookupReferenceGrant: () => Effect.succeed("wrong"),
          },
          { threadId: threadA, runId: undefined },
        );
        expect(result).toBeUndefined();
        h.bind("run", fresh, fresh.id, "explicit-sender-inheritance");
        expect(yield* h.resolve(fresh)).toMatchObject({ grant: "explicit-sender-inheritance" });
      }),
  );
});
