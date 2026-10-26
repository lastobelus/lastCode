import {
  CommandId,
  type OrchestrationV2InternalCommand,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

export class SubagentPromotionExecutionError extends Schema.TaggedError<SubagentPromotionExecutionError>()(
  "SubagentPromotionExecutionError",
  { threadId: ThreadId, requestId: CommandId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to execute subagent promotion ${this.requestId}.`;
  }
}

export class SubagentPromotionService extends Context.Service<
  SubagentPromotionService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      /** False on the final outbox attempt; transient failures otherwise retain the native result. */
      readonly willRetry?: boolean;
    }) => Effect.Effect<void, SubagentPromotionExecutionError>;
  }
>()("t3/orchestration-v2/SubagentPromotionService") {}

type PromotionResult = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "subagent.promote.complete" | "subagent.promote.fail" }
>;

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const policy = yield* RuntimePolicy.RuntimePolicyV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const requests = yield* KeyedLock.make<CommandId>();
  // Keep a native result across a failed commit/outbox retry. The provider's
  // fork API has no idempotency key: process loss between native fork and the
  // atomic completion can leave an unreferenced native fork, but never a
  // partially published app thread.
  const pendingResults = new Map<CommandId, PromotionResult>();

  const execute: SubagentPromotionService["Service"]["execute"] = (input) =>
    requests
      .withLock(
        input.requestId,
        Effect.gen(function* () {
          const source = yield* projections.getThreadRecords(input.threadId, [
            "providerThreads",
            "providerTurns",
          ]);
          const promotion = source.thread.subagentPromotion;
          if (
            promotion?.requestId !== input.requestId ||
            promotion.status !== "forking" ||
            source.thread.deletedAt !== null
          ) {
            pendingResults.delete(input.requestId);
            return;
          }

          let result = pendingResults.get(input.requestId);
          if (result === undefined) {
            let failureMessage = "The subagent has no durable native thread to fork.";
            result = yield* Effect.gen(function* () {
              const sourceProviderThread =
                source.providerThreads.find(
                  (thread) => thread.id === source.thread.activeProviderThreadId,
                ) ??
                source.providerThreads.findLast(
                  (thread) => thread.appThreadId === source.thread.id,
                );
              if (sourceProviderThread?.nativeThreadRef?.strength !== "strong") {
                return yield* Effect.fail("The subagent has no durable native thread to fork.");
              }
              const sourceNativeRef = sourceProviderThread.nativeThreadRef;
              failureMessage =
                "The source provider is unavailable. Check its connection and try again.";
              const adapter = yield* adapters.get(sourceProviderThread.providerInstanceId);
              const capabilities = yield* adapter.getCapabilities();
              if (
                !capabilities.threads.canForkThread ||
                !capabilities.threads.canForkFromSubagentThread
              ) {
                failureMessage = "This provider cannot promote native subagent threads.";
                return yield* Effect.fail("This provider cannot promote native subagent threads.");
              }
              const modelSelection = {
                ...source.thread.modelSelection,
                instanceId: sourceProviderThread.providerInstanceId,
              };
              failureMessage =
                "The provider workspace could not be prepared. Check its settings and try again.";
              const runtimePolicy = yield* policy.resolve({
                thread: source.thread,
                modelSelection,
              });
              // This scoped runtime has no event pump or app-thread attachment.
              // Promotion remains available after the parent session is gone and
              // does not resume, turn, or otherwise mutate the source subagent.
              const snapshot = yield* Effect.scoped(
                Effect.gen(function* () {
                  failureMessage =
                    "The provider could not connect. Check its connection and try again.";
                  const session = yield* adapter.openSession({
                    threadId: promotion.targetThreadId,
                    providerSessionId: ProviderSessionId.make(
                      `provider-session:subagent-promotion:${input.requestId}`,
                    ),
                    modelSelection,
                    runtimePolicy,
                  });
                  failureMessage = "The provider could not fork the subagent. Try promotion again.";
                  const providerThread = yield* session.forkThread({
                    sourceProviderThread,
                    sourceProviderTurns: source.providerTurns,
                    targetThreadId: promotion.targetThreadId,
                    modelSelection,
                    runtimePolicy,
                    ...(promotion.sourceProviderTurnId === undefined
                      ? {}
                      : { providerTurnId: promotion.sourceProviderTurnId }),
                  });
                  if (
                    providerThread.nativeThreadRef?.strength !== "strong" ||
                    (providerThread.nativeThreadRef.driver === sourceNativeRef.driver &&
                      providerThread.nativeThreadRef.nativeId === sourceNativeRef.nativeId)
                  ) {
                    return yield* Effect.fail(
                      "The provider did not return an independent native fork.",
                    );
                  }
                  failureMessage =
                    "The provider could not read the forked history. Try promotion again.";
                  const snapshot = yield* session.readThreadSnapshot({ providerThread });
                  if (
                    snapshot.providerThread.nativeThreadRef?.driver !==
                      providerThread.nativeThreadRef.driver ||
                    snapshot.providerThread.nativeThreadRef?.nativeId !==
                      providerThread.nativeThreadRef.nativeId
                  ) {
                    return yield* Effect.fail(
                      "The provider snapshot belongs to a different native thread.",
                    );
                  }
                  return snapshot;
                }),
              );
              return {
                type: "subagent.promote.complete" as const,
                commandId: CommandId.make(`${input.requestId}:promotion-complete`),
                threadId: input.threadId,
                requestId: input.requestId,
                providerThread: snapshot.providerThread,
                snapshot: {
                  providerTurns: snapshot.providerTurns,
                  messages: snapshot.messages,
                },
              };
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Subagent native promotion failed", {
                      threadId: input.threadId,
                      requestId: input.requestId,
                      cause,
                    }).pipe(
                      Effect.as({
                        type: "subagent.promote.fail" as const,
                        commandId: CommandId.make(`${input.requestId}:promotion-fail`),
                        threadId: input.threadId,
                        requestId: input.requestId,
                        error: failureMessage,
                      }),
                    ),
              ),
            );
            pendingResults.set(input.requestId, result);
          }
          const pending = result;
          yield* orchestrator.dispatch(pending).pipe(
            Effect.catch((cause) => {
              const permanentlyRejected =
                cause._tag === "OrchestratorCommandRejectedError" ||
                cause._tag === "OrchestratorCommandPreviouslyRejectedError";
              if (
                pending.type !== "subagent.promote.complete" ||
                (!permanentlyRejected && input.willRetry !== false)
              ) {
                return Effect.fail(cause);
              }
              // A rejected completion receipt cannot become accepted on replay.
              // Persist a distinct failure command so the source offers Retry;
              // cache it too if recording that failure temporarily cannot commit.
              const failed: PromotionResult = {
                type: "subagent.promote.fail",
                commandId: CommandId.make(`${input.requestId}:promotion-completion-failed`),
                threadId: input.threadId,
                requestId: input.requestId,
                error: permanentlyRejected
                  ? "Promotion could not be completed. Finish any pending parent work, then retry promotion."
                  : "Promotion could not be saved after repeated attempts. Check the server connection and retry promotion.",
              };
              pendingResults.set(input.requestId, failed);
              return Effect.logWarning("Subagent promotion completion could not commit", {
                threadId: input.threadId,
                requestId: input.requestId,
                permanentlyRejected,
                cause,
              }).pipe(Effect.andThen(orchestrator.dispatch(failed)));
            }),
          );
          pendingResults.delete(input.requestId);
        }),
      )
      .pipe(Effect.mapError((cause) => new SubagentPromotionExecutionError({ ...input, cause })));

  return SubagentPromotionService.of({ execute });
});

export const layer = Layer.effect(SubagentPromotionService, make);
