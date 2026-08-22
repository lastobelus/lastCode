import { IsoDateTime, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnRequestCorrelation = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  state: Schema.Literals(["pending", "started", "error", "interrupted"]),
  requestedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurnRequestCorrelation = typeof ProjectionTurnRequestCorrelation.Type;

export interface ProjectionTurnRequestCorrelationRepositoryShape {
  readonly insertPending: (
    row: Pick<ProjectionTurnRequestCorrelation, "threadId" | "messageId" | "requestedAt">,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly resolve: (
    row: Pick<
      ProjectionTurnRequestCorrelation,
      "threadId" | "messageId" | "turnId" | "state" | "resolvedAt"
    >,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<Option.Option<ProjectionTurnRequestCorrelation>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnRequestCorrelationRepository extends Context.Service<
  ProjectionTurnRequestCorrelationRepository,
  ProjectionTurnRequestCorrelationRepositoryShape
>()(
  "t3/persistence/Services/ProjectionTurnRequestCorrelations/ProjectionTurnRequestCorrelationRepository",
) {}
