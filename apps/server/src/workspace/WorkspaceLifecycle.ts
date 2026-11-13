import type {
  WorkspaceLifecyclePreview,
  WorkspaceLifecyclePreviewInput,
  WorkspaceLifecycleRunInput,
} from "@t3tools/contracts";
import { WorktreeSuspensionRequestError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface WorkspaceLifecycleHandler {
  readonly preview: (
    input: WorkspaceLifecyclePreviewInput,
    access?: { readonly allowOrphans: boolean },
  ) => Effect.Effect<WorkspaceLifecyclePreview, WorktreeSuspensionRequestError>;
  readonly run: <A, E, R>(
    input: WorkspaceLifecycleRunInput,
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeSuspensionRequestError, R>;
}

export class WorkspaceLifecycle extends Context.Service<
  WorkspaceLifecycle,
  WorkspaceLifecycleHandler & {
    readonly install: (handler: WorkspaceLifecycleHandler) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceLifecycle") {}

const make = Effect.gen(function* () {
  // The controller needs orchestration while lifecycle commands need its saved
  // data checks. Install the controller after construction, before admitting work.
  const handler = yield* Deferred.make<WorkspaceLifecycleHandler>();
  const preview = Effect.fn("WorkspaceLifecycle.preview")(function* (
    input: WorkspaceLifecyclePreviewInput,
    access?: { readonly allowOrphans: boolean },
  ) {
    return yield* (yield* Deferred.await(handler)).preview(input, access);
  });
  const run: WorkspaceLifecycleHandler["run"] = Effect.fn("WorkspaceLifecycle.run")(function* <
    A,
    E,
    R,
  >(input: WorkspaceLifecycleRunInput, commit: Effect.Effect<A, E, R>) {
    return yield* (yield* Deferred.await(handler)).run(input, commit);
  });
  const install = Effect.fn("WorkspaceLifecycle.install")(function* (
    next: WorkspaceLifecycleHandler,
  ) {
    yield* Deferred.succeed(handler, next);
  });
  return WorkspaceLifecycle.of({ preview, run, install });
});

export const layer = Layer.effect(WorkspaceLifecycle, make);
