import {
  CommandId,
  type MessageId,
  type ThreadId,
  type OrchestrationV2IncomingMessageSummary,
} from "@t3tools/contracts";
import { createModelSelection, codexModelFamily } from "@t3tools/shared/model";
import { isIncomingUserMessage, resolveUserMessagePresentation } from "@t3tools/shared/userMessage";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class IncomingMessageSummaryService extends Context.Service<
  IncomingMessageSummaryService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly attemptCount: number;
    }) => Effect.Effect<void, OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/IncomingMessageSummaryService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const generation = yield* TextGeneration.TextGeneration;

  const execute: IncomingMessageSummaryService["Service"]["execute"] = Effect.fn(
    "IncomingMessageSummaryService.execute",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [input.messageId],
    });
    const message = projection.messages[0];
    if (
      projection.thread.deletedAt !== null ||
      message?.incomingSummary?.status !== "pending" ||
      !isIncomingUserMessage(message)
    )
      return;

    // A crash after launching the provider cannot prove whether it billed or
    // completed. Settle the preview on recovery instead of generating it again.
    const summary: Exclude<OrchestrationV2IncomingMessageSummary, { status: "pending" }> =
      input.attemptCount > 1
        ? { status: "failed" }
        : yield* Effect.gen(function* () {
            const instances = yield* registry.listInstances;
            for (const instance of instances) {
              if (!instance.enabled || instance.driverKind !== "codex") continue;
              const snapshot = yield* instance.snapshot.getSnapshot;
              if (
                !snapshot.installed ||
                snapshot.status === "disabled" ||
                snapshot.status === "error" ||
                snapshot.auth.status === "unauthenticated"
              )
                continue;
              const model = snapshot.models.find(
                (candidate) =>
                  candidate.slug === "gpt-6-luna" ||
                  (!candidate.isCustom && codexModelFamily(candidate.slug) === "gpt-6-luna"),
              );
              if (model === undefined) continue;
              const result = yield* generation.generateIncomingMessageSummary({
                cwd: ".",
                message: resolveUserMessagePresentation(message).text,
                modelSelection: createModelSelection(instance.instanceId, model.slug, [
                  { id: "reasoningEffort", value: "xhigh" },
                  { id: "serviceTier", value: "default" },
                ]),
              });
              return { status: "ready" as const, text: result.text };
            }
            return { status: "failed" as const };
          }).pipe(
            Effect.timeoutOption("45 seconds"),
            Effect.map(Option.getOrElse(() => ({ status: "failed" as const }))),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Incoming message preview generation failed", {
                    threadId: input.threadId,
                    messageId: input.messageId,
                  }).pipe(Effect.as({ status: "failed" as const })),
            ),
          );
    yield* threads.dispatch({
      type: "message.incoming-summary.complete",
      commandId: CommandId.make(`incoming-message-summary:${input.messageId}:complete`),
      threadId: input.threadId,
      messageId: input.messageId,
      sourceText: message.text,
      summary,
    });
  });
  return IncomingMessageSummaryService.of({ execute });
});

export const layer = Layer.effect(IncomingMessageSummaryService, make);
