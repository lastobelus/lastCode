import type { OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  ACTIVE_RUN_STATUSES,
  latestActiveRun,
  latestRun,
} from "../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadCaller } from "./McpInvocationContext.ts";

type CallerField = "runs" | "attempts" | "providerThreads" | "providerSessions";
type ReadCaller<E, R> = <K extends CallerField>(
  threadId: ThreadId,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) => Effect.Effect<ProjectionRecords<K>, E, R>;

export type CapturedMcpCaller = ProjectionRecords<"runs"> & {
  readonly invocationRun: OrchestrationV2Run | undefined;
};

export const loadMcpCaller = Effect.fn("loadMcpCaller")(function* <E, R>(
  caller: McpThreadCaller,
  read: ReadCaller<E, R>,
) {
  const parent = yield* read(caller.threadId, ["runs"], {
    runStatuses: ACTIVE_RUN_STATUSES,
  });
  const execution = caller.attribution === "unresolved" ? undefined : caller.execution;
  if (execution === undefined) {
    const absent = caller.attribution === undefined || caller.attribution === "absent";
    return {
      ...parent,
      invocationRun: absent ? (latestActiveRun(parent) ?? latestRun(parent)) : undefined,
    } satisfies CapturedMcpCaller;
  }
  // An HTTP call captured before completion still acts for that exact execution afterwards.
  const invocation = yield* read(caller.threadId, ["runs", "attempts"], {
    runIds: [execution.runId],
    attemptIds: [execution.attemptId],
  });
  const run = invocation.runs.find((run) => run.id === execution.runId);
  const attempt = invocation.attempts.find((attempt) => attempt.id === execution.attemptId);
  if (
    run?.threadId !== caller.threadId ||
    run.providerInstanceId !== caller.providerInstanceId ||
    attempt?.runId !== run.id ||
    attempt.providerInstanceId !== caller.providerInstanceId
  ) {
    return { ...parent, invocationRun: undefined } satisfies CapturedMcpCaller;
  }
  const owners = yield* read(caller.threadId, ["providerThreads", "providerSessions"], {
    providerThreadIds: [attempt.providerThreadId],
  });
  const nativeThread = owners.providerThreads.find((row) => row.id === attempt.providerThreadId);
  // The MCP credential session differs from the runtime provider session. The registry
  // verifies the former; here the exact attempt's provider thread must own the latter.
  const owned =
    nativeThread?.appThreadId === caller.threadId &&
    nativeThread.providerInstanceId === caller.providerInstanceId &&
    nativeThread.providerSessionId !== null &&
    owners.providerSessions.some(
      (session) =>
        session.id === nativeThread.providerSessionId &&
        session.providerInstanceId === caller.providerInstanceId,
    );
  return {
    ...parent,
    invocationRun: owned ? run : undefined,
  } satisfies CapturedMcpCaller;
});
