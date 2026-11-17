import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import { loadMcpCaller } from "./McpCallerAttribution.ts";
import type { McpThreadCaller } from "./McpInvocationContext.ts";

const threadId = ThreadId.make("caller");
const instanceId = ProviderInstanceId.make("provider");
const providerThreadId = ProviderThreadId.make("native-owner");
const providerSessionId = ProviderSessionId.make("runtime-session");
const now = DateTime.makeUnsafe(0);
const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal,
  status,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  providerThreadId,
  userMessageId: MessageId.make(id),
  rootNodeId: NodeId.make(id),
  activeAttemptId: RunAttemptId.make(id),
  requestedAt: now,
  startedAt: now,
  completedAt: status === "completed" ? now : null,
  checkpointId: null,
  contextHandoffId: null,
});
const a = run("a", 1, "completed");
const b = run("b", 2, "running");
const attempt: OrchestrationV2RunAttempt = {
  id: RunAttemptId.make("a"),
  runId: a.id,
  attemptOrdinal: 1,
  rootNodeId: NodeId.make("a"),
  providerInstanceId: instanceId,
  providerThreadId,
  providerTurnId: null,
  reason: "initial",
  status: "completed",
  startedAt: now,
  completedAt: now,
};
const nativeThread = {
  id: providerThreadId,
  appThreadId: threadId,
  providerInstanceId: instanceId,
  providerSessionId,
} as OrchestrationV2ProviderThread;
const session = {
  id: providerSessionId,
  providerInstanceId: instanceId,
} as OrchestrationV2ProviderSession;
const thread = { id: threadId } as OrchestrationV2AppThread;
const caller: McpThreadCaller = {
  threadId,
  providerInstanceId: instanceId,
  providerSessionId: "mcp-credential",
  execution: { runId: a.id, attemptId: attempt.id },
};

const fixture = (overrides?: {
  attempt?: OrchestrationV2RunAttempt;
  nativeThread?: OrchestrationV2ProviderThread;
  session?: OrchestrationV2ProviderSession;
}) => {
  const reads: Array<{
    fields: ReadonlyArray<string>;
    filter: ProjectionRecordFilter | undefined;
  }> = [];
  const read = <K extends "runs" | "attempts" | "providerThreads" | "providerSessions">(
    _threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => {
    reads.push({ fields, filter });
    const records: ProjectionRecords<"runs" | "attempts" | "providerThreads" | "providerSessions"> =
      {
        thread,
        runs: [a, b].filter(
          (row) =>
            (filter?.runIds === undefined || filter.runIds.includes(row.id)) &&
            (filter?.runStatuses === undefined || filter.runStatuses.includes(row.status)),
        ),
        attempts: [overrides?.attempt ?? attempt],
        providerThreads: [overrides?.nativeThread ?? nativeThread],
        providerSessions: [overrides?.session ?? session],
      };
    return Effect.succeed<ProjectionRecords<K>>(records);
  };
  return { read, reads };
};

it.effect("captures the exact ended run and attempt before a newer user's run", () =>
  Effect.gen(function* () {
    const { read, reads } = fixture();
    const captured = yield* loadMcpCaller(caller, read);
    expect(captured.invocationRun?.id).toBe(a.id);
    expect(captured.runs.map((row) => row.id)).toEqual([b.id]);
    expect(reads[0]?.filter?.runStatuses).toContain("running");
    expect(reads[1]?.filter).toMatchObject({ runIds: [a.id], attemptIds: [attempt.id] });
    expect(reads[1]?.filter?.runStatuses).toBeUndefined();
  }),
);

it.effect(
  "rejects foreign attempt, thread, provider and session ownership without borrowing the active run",
  () =>
    Effect.gen(function* () {
      for (const overrides of [
        { attempt: { ...attempt, runId: b.id } },
        { attempt: { ...attempt, providerInstanceId: ProviderInstanceId.make("foreign") } },
        { nativeThread: { ...nativeThread, appThreadId: ThreadId.make("foreign") } },
        {
          nativeThread: { ...nativeThread, providerInstanceId: ProviderInstanceId.make("foreign") },
        },
        { nativeThread: { ...nativeThread, providerSessionId: ProviderSessionId.make("foreign") } },
        { session: { ...session, providerInstanceId: ProviderInstanceId.make("foreign") } },
      ]) {
        expect(
          (yield* loadMcpCaller(caller, fixture(overrides).read)).invocationRun,
        ).toBeUndefined();
      }
      expect(
        (yield* loadMcpCaller(
          { ...caller, providerInstanceId: ProviderInstanceId.make("foreign") },
          fixture().read,
        )).invocationRun,
      ).toBeUndefined();
      expect(
        (yield* loadMcpCaller(
          { ...caller, execution: { ...caller.execution!, runId: RunId.make("missing") } },
          fixture().read,
        )).invocationRun,
      ).toBeUndefined();
    }),
);

it.effect("allows legacy selection only when native metadata is absent", () =>
  Effect.gen(function* () {
    for (const attribution of [undefined, "absent", "unresolved", "resolved"] as const) {
      const captured = yield* loadMcpCaller(
        { ...caller, execution: undefined, attribution },
        fixture().read,
      );
      expect(captured.invocationRun?.id).toBe(
        attribution === undefined || attribution === "absent" ? b.id : undefined,
      );
      expect(captured.runs.map((row) => row.id)).toEqual([b.id]);
    }
    expect(
      (yield* loadMcpCaller({ ...caller, attribution: "unresolved" }, fixture().read))
        .invocationRun,
    ).toBeUndefined();
  }),
);
