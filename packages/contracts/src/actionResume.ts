import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ActionResumeOutcome = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled_by_user",
  "cancelled_by_archive",
  "cancelled_by_shutdown",
  "process_lost",
]);
export type ActionResumeOutcome = typeof ActionResumeOutcome.Type;

export const ActionResumeDelivery = Schema.Literals([
  "armed",
  "pending",
  "delivered",
  "disposed",
  "available",
]);
export type ActionResumeDelivery = typeof ActionResumeDelivery.Type;

export const ActionReportOutcome = Schema.Literals(["success", "attention", "blocked"]);
export type ActionReportOutcome = typeof ActionReportOutcome.Type;

const ActionReportShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(280));
const ActionReportDetailText = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const ActionProgressSummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(280),
  Schema.makeFilter(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }) || "Action progress summaries must not contain control characters",
  ),
);
const ActionReportUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const parsed = new URL(value);
      return (
        ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username.length === 0 &&
          parsed.password.length === 0) ||
        "Action report URLs must use http(s) without embedded credentials"
      );
    } catch {
      return "Action report URLs must be valid absolute URLs";
    }
  }),
);

export const ActionReportSubject = Schema.Struct({
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  revision: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  url: Schema.optional(ActionReportUrl),
});
export type ActionReportSubject = typeof ActionReportSubject.Type;

export const ActionReportArtifact = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  url: ActionReportUrl,
});
export type ActionReportArtifact = typeof ActionReportArtifact.Type;

export const ActionReport = Schema.Struct({
  version: Schema.Literal(1),
  outcome: ActionReportOutcome,
  summary: ActionReportShortText,
  reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  subject: Schema.optional(ActionReportSubject),
  facts: Schema.optional(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
      TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
    ).check(
      Schema.makeFilter(
        (facts) => Object.keys(facts).length <= 16 || "Action reports may contain at most 16 facts",
      ),
    ),
  ),
  artifacts: Schema.optional(Schema.Array(ActionReportArtifact).check(Schema.isMaxLength(8))),
});
export type ActionReport = typeof ActionReport.Type;

export const ActionProgressState = Schema.Literals(["working", "waiting"]);
export type ActionProgressState = typeof ActionProgressState.Type;

const ActionProgressFields = Schema.Struct({
  version: Schema.Literal(1),
  state: ActionProgressState,
  summary: ActionProgressSummary,
  phase: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  detail: Schema.optional(ActionReportDetailText),
  current: Schema.optional(NonNegativeInt),
  total: Schema.optional(PositiveInt),
  unit: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
});
export const ActionProgress = ActionProgressFields.check(
  Schema.makeFilter(
    (progress) =>
      progress.current === undefined ||
      progress.total === undefined ||
      progress.current <= progress.total ||
      "Action progress current value cannot exceed its total",
  ),
);
export type ActionProgress = typeof ActionProgress.Type;

/** Host-stamped progress persisted with the Action lifecycle state. */
export const ActionResumeProgress = Schema.Struct({
  ...ActionProgressFields.fields,
  updatedAt: IsoDateTime,
}).check(
  Schema.makeFilter(
    (progress) =>
      progress.current === undefined ||
      progress.total === undefined ||
      progress.current <= progress.total ||
      "Action progress current value cannot exceed its total",
  ),
);
export type ActionResumeProgress = typeof ActionResumeProgress.Type;

const ActionProtocolEventFields = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("progress"),
    progress: ActionProgress,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    report: ActionReport,
  }),
]);
const ACTION_PROTOCOL_EVENT_MAX_JSON_CHARS = 10_000;
export const ActionProtocolEvent = ActionProtocolEventFields.check(
  Schema.makeFilter(
    (event) =>
      JSON.stringify(event).length <= ACTION_PROTOCOL_EVENT_MAX_JSON_CHARS ||
      `Action protocol events may contain at most ${ACTION_PROTOCOL_EVENT_MAX_JSON_CHARS} serialized characters`,
  ),
);
export type ActionProtocolEvent = typeof ActionProtocolEvent.Type;

/**
 * Durable one-shot state for one Project Action process and its follow-up.
 * The thread shell exposes the latest run; retained runs preserve their output.
 */
export const ActionResumeState = Schema.Struct({
  runId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  actionId: TrimmedNonEmptyString,
  actionName: TrimmedNonEmptyString,
  /** Exact command captured at launch; absent on states persisted by older servers. */
  command: Schema.optional(TrimmedNonEmptyString),
  terminalId: TrimmedNonEmptyString,
  outcome: ActionResumeOutcome,
  delivery: ActionResumeDelivery,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Monotonic per-run lifecycle revision; absent persisted rows are revision zero. */
  revision: Schema.optional(NonNegativeInt),
  /** Latest schema-validated progress emitted by a protocol-aware Action. */
  progress: Schema.optional(ActionResumeProgress),
  /** Terminal domain result emitted by a protocol-aware Action. */
  report: Schema.optional(ActionReport),
});
export type ActionResumeState = typeof ActionResumeState.Type;

export const ActionRunInspection = Schema.Struct({
  runId: TrimmedNonEmptyString,
  actionName: TrimmedNonEmptyString,
  lifecycleOutcome: ActionResumeOutcome,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  outputTail: Schema.String.check(Schema.isMaxLength(12_000)),
});
export type ActionRunInspection = typeof ActionRunInspection.Type;

export class ActionResumeError extends Schema.TaggedError<ActionResumeError>()(
  "ActionResumeError",
  {
    reason: Schema.Literals([
      "unsupported_provider",
      "thread_not_found",
      "project_not_found",
      "action_not_found",
      "action_run_not_found",
      "action_not_enabled",
      "action_already_running",
      "action_not_recoverable",
      "launch_failed",
      "internal_error",
    ]),
    message: Schema.String,
  },
) {}
