import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  type CommandId,
  type ThreadId,
  type OrchestrationMessageContext,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Binds only remote thread-read authority to a new input before provider execution. */
export class ThreadReadAuthorization extends Context.Reference<{
  readonly authorize: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<void>;
}>("t3/orchestration/ThreadReadAuthorization", {
  defaultValue: () => ({ authorize: () => Effect.void }),
}) {}

export const questionAnswerAuthorizationId = (commandId: CommandId): MessageId =>
  MessageId.make(`answer-context:${commandId}`);

export const queuedEditAuthorizationId = (commandId: CommandId): MessageId =>
  MessageId.make(`queued-edit-context:${commandId}`);

export function referencedThreads(
  text: string,
  context: OrchestrationMessageContext | undefined,
): ThreadContextRecord[] {
  const ids = new Set(
    collectComposerContextReferences(text)
      .filter((reference) => reference.kind === "thread")
      .map((reference) => reference.contextId),
  );
  return [
    ...new Map((context?.records ?? []).map((record) => [record.contextId, record])).values(),
  ].filter(
    (record): record is ThreadContextRecord =>
      record.kind === "thread" && ids.has(record.contextId),
  );
}
