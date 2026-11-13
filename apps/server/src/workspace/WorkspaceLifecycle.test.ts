import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  WorktreeSuspensionRequestError,
  type WorkspaceLifecyclePreview,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as WorkspaceLifecycle from "./WorkspaceLifecycle.ts";

const target = { kind: "threads" as const, threadIds: [ThreadId.make("thread")] };
const input = { operation: "delete" as const, target, commandId: CommandId.make("delete") };
const preview: WorkspaceLifecyclePreview = {
  token: "exact-preview",
  snapshots: [],
  retainedSnapshots: [],
  bytes: 0,
  threadIds: target.threadIds,
  projectIds: [],
  message: "No saved copies.",
};

it.effect("does not commit deletion until the controller installs its lifecycle checks", () =>
  Effect.gen(function* () {
    const port = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    const committed = yield* Deferred.make<void>();
    const deletion = yield* port
      .run(input, Deferred.succeed(committed, undefined))
      .pipe(Effect.forkChild);
    assert.strictEqual(yield* Deferred.isDone(committed), false);
    yield* port.install({
      preview: () => Effect.succeed(preview),
      run: (_input, commit) => commit,
    });
    yield* Fiber.join(deletion);
    assert.strictEqual(yield* Deferred.isDone(committed), true);
  }).pipe(Effect.provide(WorkspaceLifecycle.layer)),
);

it.effect("a stale disposal preview prevents the lifecycle commit", () =>
  Effect.gen(function* () {
    const port = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    const committed = yield* Deferred.make<void>();
    yield* port.install({
      preview: () => Effect.succeed(preview),
      run: () =>
        Effect.fail(
          new WorktreeSuspensionRequestError({
            reason: "changed",
            message: "Saved copies changed.",
          }),
        ),
    });
    const error = yield* port
      .run(
        { ...input, savedWorkspace: { mode: "discard", previewToken: "stale" } },
        Deferred.succeed(committed, undefined),
      )
      .pipe(Effect.flip);
    assert.strictEqual(error.message, "Saved copies changed.");
    assert.strictEqual(yield* Deferred.isDone(committed), false);
  }).pipe(Effect.provide(WorkspaceLifecycle.layer)),
);

it.effect("passes commit failures through without reporting lifecycle success", () =>
  Effect.gen(function* () {
    const port = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    yield* port.install({
      preview: () => Effect.succeed(preview),
      run: (_input, commit) => commit,
    });
    const failure = { reason: "thread is protected" };
    assert.strictEqual(yield* port.run(input, Effect.fail(failure)).pipe(Effect.flip), failure);
  }).pipe(Effect.provide(WorkspaceLifecycle.layer)),
);

it.effect("a duplicate install cannot replace the original lifecycle authority", () =>
  Effect.gen(function* () {
    const port = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    yield* port.install({
      preview: () => Effect.succeed(preview),
      run: () =>
        Effect.fail(
          new WorktreeSuspensionRequestError({
            reason: "protected",
            message: "Keep recovery data.",
          }),
        ),
    });
    yield* port.install({
      preview: () => Effect.succeed(preview),
      run: (_input, commit) => commit,
    });
    const failure = yield* port.run(input, Effect.succeed("deleted")).pipe(Effect.flip);
    assert.equal(failure.reason, "protected");
  }).pipe(Effect.provide(WorkspaceLifecycle.layer)),
);
