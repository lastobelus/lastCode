import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Binds only remote thread-read authority to a new input before provider execution. */
export class ThreadReadAuthorization extends Context.Reference<{
  readonly authorize: (threadId: ThreadId, messageId: MessageId) => Effect.Effect<void>;
}>("t3/orchestration/ThreadReadAuthorization", {
  defaultValue: () => ({ authorize: () => Effect.void }),
}) {}
