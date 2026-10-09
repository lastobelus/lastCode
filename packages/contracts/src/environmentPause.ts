import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { UpdateDrainBlocker } from "./updateDrain.ts";

const EnvironmentPauseDelivery = Schema.Literals(["pending", "sent", "failed"]);
export const EnvironmentPauseTarget = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  pause: EnvironmentPauseDelivery,
  /** An archived or deleted recipient can finish recovery without receiving Resume. */
  resume: Schema.Literals(["pending", "sent", "failed", "unavailable"]),
  error: Schema.NullOr(Schema.String),
});
export type EnvironmentPauseTarget = typeof EnvironmentPauseTarget.Type;

export const EnvironmentPauseSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  phase: Schema.Literals(["pausing", "paused", "resuming"]),
  targets: Schema.Array(EnvironmentPauseTarget),
});
export type EnvironmentPauseSession = typeof EnvironmentPauseSession.Type;

export const environmentPauseResumeComplete = (session: EnvironmentPauseSession) =>
  session.targets.every(
    (target) =>
      target.pause !== "sent" || target.resume === "sent" || target.resume === "unavailable",
  );

export const EnvironmentPauseStatus = Schema.Struct({
  session: Schema.NullOr(EnvironmentPauseSession),
  activeThreadCount: NonNegativeInt,
  blockers: Schema.Array(UpdateDrainBlocker),
  quiet: Schema.Boolean,
  observation: Schema.Literals(["known", "unknown"]),
});
export type EnvironmentPauseStatus = typeof EnvironmentPauseStatus.Type;

export class EnvironmentPauseError extends Schema.TaggedError<EnvironmentPauseError>()(
  "EnvironmentPauseError",
  {
    operation: Schema.Literals(["status", "start", "retry", "resume", "persist"]),
    reason: Schema.Literals(["disabled", "no_session", "resume_in_progress", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Enable environment pause in Settings before starting a pause.";
      case "no_session":
        return "This environment has no pause session to recover.";
      case "resume_in_progress":
        return "Finish resuming this environment before starting another pause.";
      case "unavailable":
        return "Environment pause could not confirm the server's current state.";
    }
  }
}
