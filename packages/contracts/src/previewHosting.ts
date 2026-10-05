import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PreviewUrl = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2_048));
const PreviewCommand = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(8_192));
const PreviewPath = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(8_192));
const EnvironmentKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(
  Schema.isMaxLength(128),
);
const EnvironmentValue = Schema.String.check(Schema.isMaxLength(8_192));
const Environment = Schema.Record(EnvironmentKey, EnvironmentValue).check(
  Schema.isMaxProperties(128),
);

export const PreviewHostingLeaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewHostingLeaseId = typeof PreviewHostingLeaseId.Type;

export const PreviewHostingLaunchInput = Schema.Struct({
  command: PreviewCommand.annotate({
    description: "The exact shell command that starts the preview server.",
  }),
  cwd: PreviewPath.annotate({
    description: "The absolute directory where the preview command should run.",
  }),
  worktreePath: Schema.optional(Schema.NullOr(PreviewPath)).annotate({
    description: "The source worktree root to retain until expiry; inferred from cwd when omitted.",
  }),
  env: Schema.optional(Environment).annotate({
    description: "Environment variable overrides for the preview command.",
  }),
  url: PreviewUrl.annotate({
    description: "The exact local HTTP or HTTPS URL served by the preview command.",
  }),
});
export type PreviewHostingLaunchInput = typeof PreviewHostingLaunchInput.Type;

export const PreviewHostingLeaseSummary = Schema.Struct({
  leaseId: PreviewHostingLeaseId,
  threadId: ThreadId,
  url: PreviewUrl,
  handedOffAt: Schema.String,
  expiresAt: Schema.String,
  status: Schema.Literals(["starting", "active"]),
});
export type PreviewHostingLeaseSummary = typeof PreviewHostingLeaseSummary.Type;

export const PreviewHostingRecoverInput = Schema.Struct({
  threadId: ThreadId,
  leaseId: PreviewHostingLeaseId,
  url: PreviewUrl,
});
export type PreviewHostingRecoverInput = typeof PreviewHostingRecoverInput.Type;

export const PreviewHostingListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewHostingListInput = typeof PreviewHostingListInput.Type;

export class PreviewHostingError extends Schema.TaggedError<PreviewHostingError>()(
  "PreviewHostingError",
  {
    reason: Schema.Literals(["invalid_request", "url_in_use", "unavailable"]),
    message: Schema.String.check(Schema.isMaxLength(1_024)),
  },
) {}
export const PreviewHostingRecoverResult = Schema.NullOr(PreviewHostingLeaseSummary);
export type PreviewHostingRecoverResult = typeof PreviewHostingRecoverResult.Type;
