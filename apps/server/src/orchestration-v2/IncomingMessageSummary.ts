import {
  type CommandId,
  type MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2IncomingMessageSummary,
} from "@t3tools/contracts";
import {
  isIncomingUserMessage,
  isShortIncomingMessage,
  resolveUserMessagePresentation,
} from "@t3tools/shared/userMessage";
import * as Effect from "effect/Effect";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** New messages enqueue metadata work; item/update events reuse the persisted result. */
export const planIncomingMessageSummaries = Effect.fn("planIncomingMessageSummaries")(
  function* (input: {
    readonly commandId: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const summaries = new Map<MessageId, OrchestrationV2IncomingMessageSummary>();
    const effects: Array<PendingOrchestrationEffectV2> = [];
    const finalMessages = new Map<
      MessageId,
      Extract<OrchestrationV2DomainEvent, { type: "message.updated" }>
    >();
    for (const event of input.events) {
      if (event.type !== "message.updated" || !isIncomingUserMessage(event.payload)) continue;
      finalMessages.set(event.payload.id, event);
    }
    for (const event of finalMessages.values()) {
      const message = event.payload;
      const existing = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [message.id],
      });
      const previous = existing.messages[0];
      if (previous !== undefined) {
        // A preview describes one immutable body. Editing that body keeps the
        // current original visible and never schedules a second generation.
        const summary =
          previous.incomingSummary !== undefined && previous.text !== message.text
            ? { status: "failed" as const }
            : (message.incomingSummary ?? previous.incomingSummary);
        if (summary !== undefined) summaries.set(message.id, summary);
        continue;
      }
      if (message.incomingSummary !== undefined) {
        summaries.set(message.id, message.incomingSummary);
        continue;
      }
      if (message.streaming || isShortIncomingMessage(resolveUserMessagePresentation(message).text))
        continue;
      summaries.set(message.id, { status: "pending" });
      effects.push({
        id: `incoming-message-summary:${message.id}`,
        commandId: input.commandId,
        threadId: event.threadId,
        request: { type: "incoming-message.summarize", messageId: message.id },
      });
    }
    // Native providers emit the prompt and its timeline item separately. The
    // summary may already have finished by the time that item is committed.
    for (const event of input.events) {
      if (
        event.type !== "turn-item.updated" ||
        event.payload.type !== "user_message" ||
        !isIncomingUserMessage({ ...event.payload, role: "user" }) ||
        summaries.has(event.payload.messageId)
      )
        continue;
      const existing = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [event.payload.messageId],
      });
      const summary = existing.messages[0]?.incomingSummary;
      if (summary !== undefined) summaries.set(event.payload.messageId, summary);
    }
    return {
      effects,
      events: input.events.map((event) => {
        if (event.type === "message.updated") {
          const incomingSummary = summaries.get(event.payload.id);
          return incomingSummary === undefined
            ? event
            : { ...event, payload: { ...event.payload, incomingSummary } };
        }
        if (event.type === "turn-item.updated" && event.payload.type === "user_message") {
          const incomingSummary = summaries.get(event.payload.messageId);
          return incomingSummary === undefined
            ? event
            : { ...event, payload: { ...event.payload, incomingSummary } };
        }
        return event;
      }),
    };
  },
);
