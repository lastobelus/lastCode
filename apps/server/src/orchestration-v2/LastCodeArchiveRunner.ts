import { CommandId, getThreadArchivePlan, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class LastCodeArchiveRunner extends Context.Service<
  LastCodeArchiveRunner,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
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
    return LastCodeArchiveRunner.of({
      execute: Effect.fn("LastCodeArchiveRunner.execute")(function* (input) {
        const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { thread } = yield* orchestrator.getThreadRecords(input.threadId, []);
        const pending = getThreadArchivePlan(thread.archivePending);
        if (pending?.commandId !== input.requestId || pending.status !== "stopping") return;
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
        }
      }),
    });
  }),
);
