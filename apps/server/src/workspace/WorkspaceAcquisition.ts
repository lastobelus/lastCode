import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WorkspaceUnavailableError extends Schema.TaggedError<WorkspaceUnavailableError>()(
  "WorkspaceUnavailableError",
  {
    reason: Schema.Literals([
      "busy",
      "blocked",
      "discarded",
      "snapshot-unavailable",
      "owner-changed",
      "destination-occupied",
      "permission-denied",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "The workspace is being saved or restored. Try again when it finishes.";
      case "discarded":
        return "The saved workspace was discarded. Create a fresh worktree to continue.";
      case "snapshot-unavailable":
        return "The saved workspace cannot be verified. Its recovery data has been retained.";
      case "owner-changed":
        return "Workspace ownership changed. Review the saved workspace before continuing.";
      case "destination-occupied":
        return "The restore destination is occupied. Choose another managed location.";
      case "permission-denied":
        return "This connection cannot restore the workspace.";
      case "blocked":
        return "The workspace needs recovery before commands can run.";
    }
  }
}

export interface WorkspaceAcquisitionInput {
  readonly path: string;
  readonly threadId?: ThreadId;
  readonly purpose:
    | "provider"
    | "terminal"
    | "action"
    | "setup"
    | "preview"
    | "git"
    | "git-mutation"
    | "checkpoint"
    | "file-write"
    | "editor";
}

export interface AcquiredWorkspace {
  readonly path: string;
  readonly branch: string | null;
  readonly restored: boolean;
}

type AcquireWorkspace = (
  input: WorkspaceAcquisitionInput,
) => Effect.Effect<AcquiredWorkspace, WorkspaceUnavailableError>;

export class WorkspaceAcquisition extends Context.Service<
  WorkspaceAcquisition,
  {
    readonly acquire: AcquireWorkspace;
    readonly install: (handler: AcquireWorkspace) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceAcquisition") {}

const make = Effect.gen(function* () {
  // The recovery service needs orchestration, whose provider services also acquire
  // workspaces. This port breaks that construction cycle without admitting work
  // before the application has installed its durable recovery handler.
  const handler = yield* Deferred.make<AcquireWorkspace>();
  const acquire = Effect.fn("WorkspaceAcquisition.acquire")(function* (
    input: WorkspaceAcquisitionInput,
  ) {
    return yield* (yield* Deferred.await(handler))(input);
  });
  const install = Effect.fn("WorkspaceAcquisition.install")(function* (next: AcquireWorkspace) {
    yield* Deferred.succeed(handler, next);
  });
  return WorkspaceAcquisition.of({ acquire, install });
});

export const layer = Layer.effect(WorkspaceAcquisition, make);
