import {
  CommandId,
  getThreadArchivePlan,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadArchiveTemporaryProjectPlan,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ArchiveTemporaryProjects } from "./LastCodeArchiveTemporaryProjects.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class LastCodeArchiveRunner extends Context.Service<
  LastCodeArchiveRunner,
  {
    readonly awaitTemporaryProjectRemoval: (
      command: Extract<OrchestrationV2Command, { type: "thread.archive" }>,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly temporaryProjectPlan?: ThreadArchiveTemporaryProjectPlan | undefined;
    }) => Effect.Effect<
      void,
      Orchestrator.OrchestratorV2Error,
      ProviderSessionManager.ProviderSessionManagerV2
    >;
  }
>()("t3/orchestration-v2/LastCodeArchiveRunner") {}

const isThreadAboveModeLimitError = Schema.is(Orchestrator.OrchestratorThreadAboveModeLimitError);

export const layer = Layer.effect(
  LastCodeArchiveRunner,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* Effect.serviceOption(ArchiveTemporaryProjects);
    const outbox = yield* Effect.serviceOption(EffectOutboxV2);

    const removeProjects = Effect.fnUntraced(function* (
      thread: OrchestrationV2AppThread,
      input: Parameters<LastCodeArchiveRunner["Service"]["execute"]>[0],
    ) {
      const plan = input.temporaryProjectPlan;
      if (
        plan === undefined ||
        thread.archivedAt === null ||
        thread.archivedWith?.commandId !== input.requestId
      )
        return;
      const dispatchError = (cause: unknown) =>
        new Orchestrator.OrchestratorDispatchError({
          commandId: input.requestId,
          commandType: "thread.archive",
          cause,
        });
      if (Option.isNone(projects))
        return yield* dispatchError("Temporary project removal is unavailable.");
      yield* Effect.forEach(
        plan.projects,
        ({ projectId, threadIds }) =>
          projects.value
            .delete({
              projectId,
              commandId: CommandId.make(`${input.requestId}:remove-temporary-project:${projectId}`),
              force: true,
              wrappedProject: {
                owner: plan.owner,
                requestId: input.requestId,
                allowedOwnerThreadIds: plan.allowedOwnerThreadIds,
                expectedArchivedThreadIds: threadIds,
              },
            })
            .pipe(
              Effect.provideService(DispatchModeLimit, plan.modeLimit),
              Effect.catchTags({
                WrappedProjectChanged: (cause) => Effect.logInfo(cause.message),
              }),
              Effect.mapError(dispatchError),
            ),
        { discard: true },
      );
    });
    return LastCodeArchiveRunner.of({
      awaitTemporaryProjectRemoval: Effect.fn("LastCodeArchiveRunner.awaitTemporaryProjectRemoval")(
        function* (command) {
          if (!command.expectedTemporaryProjects?.length) return;
          const fail = (cause: unknown) =>
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            });
          if (Option.isNone(outbox))
            return yield* fail("Temporary project removal could not be observed.");
          const effectId = `effect:${command.commandId}:thread.archive`;
          yield* outbox.value.awaitSettled(effectId).pipe(Effect.mapError(fail));
          if (Option.isNone(projects))
            return yield* fail("Temporary project removal could not be observed.");
          const remainingProjects = yield* Effect.forEach(
            command.expectedTemporaryProjects,
            ({ projectId }) => projects.value.getById(projectId).pipe(Effect.mapError(fail)),
          );
          const kept = remainingProjects.flatMap((project) =>
            Option.isSome(project) ? [project.value.title] : [],
          );
          if (kept.length > 0)
            return yield* fail(
              `Archive finished without removing these temporary projects: ${kept.join(", ")}.`,
            );
          const effect = yield* outbox.value.get(effectId).pipe(Effect.mapError(fail));
          if (Option.isSome(effect) && effect.value.status === "failed")
            return yield* fail(
              "The temporary projects were removed, but deletion cleanup did not finish.",
            );
        },
      ),
      execute: Effect.fn("LastCodeArchiveRunner.execute")(function* (input) {
        const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { thread } = yield* orchestrator.getThreadRecords(input.threadId, []);
        const pending = getThreadArchivePlan(thread.archivePending);
        if (pending?.commandId !== input.requestId || pending.status !== "stopping") {
          // A recovered effect can have committed the archive before project removal.
          return yield* removeProjects(thread, input);
        }
        const stopped = yield* Effect.exit(
          Effect.gen(function* () {
            // Every participant is held before this effect becomes claimable. Shutdown is
            // strict: an adapter finalizer still running after its timeout is a failure.
            for (const threadId of pending.archiveThreadIds.toReversed()) {
              const context = yield* orchestrator.getThreadRecords(threadId, [
                "providerSessions",
                "providerThreads",
              ]);
              // A stopped projection may still have an adapter finalizer closing.
              // Include every binding, plus native mirrors' owned session references.
              const sessions = new Set([
                ...context.providerSessions.map((session) => session.id),
                ...context.providerThreads.flatMap((providerThread) =>
                  providerThread.appThreadId !== threadId ||
                  providerThread.providerSessionId === null
                    ? []
                    : [providerThread.providerSessionId],
                ),
              ]);
              for (const providerSessionId of sessions)
                yield* providerSessions.teardownThread({ threadId, providerSessionId });
            }
            yield* orchestrator.dispatch({
              type: "thread.archive.complete",
              commandId: CommandId.make(`${input.requestId}:complete`),
              threadId: input.threadId,
              requestId: input.requestId,
            });
          }),
        );
        if (stopped._tag === "Failure") {
          const failure = Cause.findErrorOption(stopped.cause);
          yield* Effect.logWarning("Thread family archive could not confirm shutdown", {
            threadId: input.threadId,
            cause: stopped.cause,
          });
          yield* orchestrator.dispatch({
            type: "thread.archive.fail",
            commandId: CommandId.make(`${input.requestId}:failed`),
            threadId: input.threadId,
            requestId: input.requestId,
            error:
              Option.isSome(failure) && isThreadAboveModeLimitError(failure.value)
                ? "Permissions changed while stopping. The family remains visible; some work may have stopped. Review the archive choices again."
                : "Could not stop all subagents and provider work. The conversations remain visible; some work may still be running. Try archiving again.",
          });
          return;
        }
        if (input.temporaryProjectPlan !== undefined) {
          const { thread: archived } = yield* orchestrator.getThreadRecords(input.threadId, []);
          yield* removeProjects(archived, input);
        }
      }),
    });
  }),
);
