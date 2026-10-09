import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import type { ThreadRecoveryService } from "./ThreadRecoveryService.ts";

/** Reuse exact-attempt recovery before archive inspection; never infer completion from an idle process. */
export function withVerifiedArchiveActivity(
  threads: ThreadManagementServiceShape,
  recovery: ThreadRecoveryService["Service"] | undefined,
): ThreadManagementServiceShape {
  const getThreadArchiveFamily = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const family = yield* threads.getThreadArchiveFamily(threadId);
      if (recovery === undefined || family.activeThreadIds.length === 0) return family;
      yield* Effect.forEach(
        family.activeThreadIds,
        (id) =>
          Effect.gen(function* () {
            const { runs } = yield* threads.getThreadRecords(id, ["runs"]);
            for (const run of runs) {
              if (run.status !== "running" || run.activeAttemptId === null) continue;
              yield* recovery
                .verify({ threadId: id, runId: run.id, attemptId: run.activeAttemptId })
                .pipe(Effect.catchTags({ ThreadRecoveryError: () => Effect.void }));
            }
          }),
        { concurrency: 4, discard: true },
      );
      return yield* threads.getThreadArchiveFamily(threadId);
    }).pipe(
      Effect.mapError((cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause })),
    );
  return {
    ...threads,
    getThreadArchiveFamily,
    dispatch: (command) =>
      command.type === "thread.archive"
        ? getThreadArchiveFamily(command.threadId).pipe(Effect.andThen(threads.dispatch(command)))
        : threads.dispatch(command),
  };
}
