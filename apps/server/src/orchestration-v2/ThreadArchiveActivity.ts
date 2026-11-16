import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { EnvironmentPauseStore } from "../environment/EnvironmentPauseStore.ts";
import { archiveConsultationTargets } from "./ThreadArchiveConsultation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import type { ThreadRecoveryService } from "./ThreadRecoveryService.ts";

/** Reuse exact-attempt recovery before archive inspection; never infer completion from an idle process. */
export function withVerifiedArchiveActivity(
  threads: ThreadManagementServiceShape,
  recovery: ThreadRecoveryService["Service"] | undefined,
): ThreadManagementServiceShape {
  const inspectVerifiedFamily = Effect.fn("ThreadArchiveActivity.inspectVerifiedFamily")(function* (
    threadId: ThreadId,
  ) {
    const family = yield* threads.getThreadArchiveFamily(threadId);
    if (recovery === undefined || family.activeThreadIds.length === 0) return family;
    yield* Effect.forEach(
      family.activeThreadIds,
      (id) =>
        Effect.gen(function* () {
          const { runs } = yield* threads.getThreadRecords(id, ["runs"], {
            runStatuses: ["running"],
          });
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
  });
  const getThreadArchiveFamily = Effect.fn("ThreadArchiveActivity.getThreadArchiveFamily")(
    function* (threadId: ThreadId) {
      const family = yield* inspectVerifiedFamily(threadId);
      const pauseStore = yield* Effect.serviceOption(EnvironmentPauseStore);
      const instances = yield* Effect.serviceOption(ProviderInstanceRegistry);
      const pause = Option.isSome(pauseStore) ? yield* pauseStore.value.get : null;
      const paused = pause !== null && pause.phase !== "resuming";
      const consultationTargets = yield* archiveConsultationTargets(
        family.activeThreadIds,
        (id) =>
          threads
            .getThreadRecords(
              id,
              [
                "runs",
                "subagents",
                "runtimeRequests",
                "providerThreads",
                "providerTurns",
                "turnItems",
              ],
              {
                runStatuses: [
                  "queued",
                  "preparing",
                  "starting",
                  "running",
                  "waiting",
                  "rolled_back",
                ],
                turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
                turnItemStatuses: ["pending", "running", "waiting"],
                runtimeRequestStatuses: ["pending"],
                subagentChildThreadIds: [...family.childThreadIds, ...family.activeThreadIds],
              },
            )
            .pipe(Effect.orElseSucceed(() => null)),
        (id) =>
          Effect.gen(function* () {
            if (paused) return false;
            const { thread } = yield* threads.getThreadRecords(id, []);
            const enabled = yield* threads.isProviderInstanceEnabledForProject({
              projectId: thread.projectId,
              instanceId: thread.modelSelection.instanceId,
            });
            if (!enabled || Option.isNone(instances)) return false;
            const instance = yield* instances.value.getInstance(thread.modelSelection.instanceId);
            if (instance === undefined || !instance.enabled) return false;
            const snapshot = yield* instance.snapshot.getSnapshot;
            return (
              snapshot.enabled &&
              snapshot.installed &&
              snapshot.availability !== "unavailable" &&
              snapshot.status !== "error" &&
              snapshot.status !== "disabled"
            );
          }).pipe(Effect.orElseSucceed(() => false)),
      );
      return { ...family, consultationTargets };
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
        ),
      ),
  );
  return {
    ...threads,
    getThreadArchiveFamily,
    dispatch: (command, options) =>
      command.type === "thread.archive"
        ? getThreadArchiveFamily(command.threadId).pipe(
            Effect.andThen(threads.dispatch(command, options)),
          )
        : threads.dispatch(command, options),
  };
}
