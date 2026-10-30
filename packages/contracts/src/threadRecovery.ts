import * as Schema from "effect/Schema";
import { ThreadId, RunId, RunAttemptId } from "./baseSchemas.ts";

export const ThreadRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  attemptId: RunAttemptId,
});
export const ThreadRecoveryResult = Schema.Struct({ ok: Schema.Literal(true) });
export const ThreadRepairResult = Schema.Struct({ threadId: ThreadId });
export class ThreadRecoveryOperationError extends Schema.TaggedError<ThreadRecoveryOperationError>()(
  "ThreadRecoveryOperationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
