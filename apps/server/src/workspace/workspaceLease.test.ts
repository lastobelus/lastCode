import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  registerWorkspaceLeaseRoot,
  retireWorkspaceLeaseAliases,
  resolveWorkspaceLeaseRoot,
  withWorkspaceLease,
} from "./workspaceLease.ts";

it.effect(
  "resolves nested commands to their nearest checkout without following a linked Git marker",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const root = yield* fs.realPath(directory);
      const nested = path.join(root, "packages", "example");
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.makeDirectory(nested, { recursive: true });
      assert.equal(yield* resolveWorkspaceLeaseRoot(nested), root);
      yield* fs.symlink(path.join(root, ".git"), path.join(nested, ".git"));
      assert.equal(yield* resolveWorkspaceLeaseRoot(nested), root);
      yield* fs.remove(path.join(nested, ".git"));
      yield* fs.writeFileString(
        path.join(nested, ".git"),
        "gitdir: /example/common/worktrees/topic\n",
      );
      yield* registerWorkspaceLeaseRoot(nested);
      assert.equal(yield* resolveWorkspaceLeaseRoot(nested), nested);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "reserves absent saved roots and every recognized alias under the current checkout key",
  () =>
    Effect.gen(function* () {
      const root = "/workspace/saved-current";
      const alias = "/workspace/saved-previous";
      yield* registerWorkspaceLeaseRoot(root, [alias]);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${root}/packages/example`), root);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${alias}/packages/example`), root);
      const entered = yield* Deferred.make<void>();
      const child = yield* withWorkspaceLease(
        root,
        Effect.gen(function* () {
          const child = yield* withWorkspaceLease(
            `${alias}/packages/example`,
            Deferred.succeed(entered, undefined),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          assert.isFalse(yield* Deferred.isDone(entered));
          yield* withWorkspaceLease(`${root}/packages/example`, Effect.void);
          assert.isFalse(yield* Deferred.isDone(entered));
          return child;
        }),
      );
      yield* Deferred.await(entered);
      yield* Fiber.join(child);
    }),
);

it.effect(
  "retires an old restore path while preserving the current root and its other aliases",
  () =>
    Effect.gen(function* () {
      const previous = "/workspace/retired-restore-previous";
      const current = "/workspace/retired-restore-current";
      const retainedAlias = "/workspace/retired-restore-retained";
      yield* registerWorkspaceLeaseRoot(current, [previous, retainedAlias]);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${previous}/packages/example`), current);
      yield* retireWorkspaceLeaseAliases(current, [previous, current]);
      assert.equal(yield* resolveWorkspaceLeaseRoot(previous), previous);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${current}/packages/example`), current);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${retainedAlias}/packages/example`), current);
      yield* registerWorkspaceLeaseRoot(previous);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${previous}/packages/example`), previous);
      assert.equal(yield* resolveWorkspaceLeaseRoot(`${retainedAlias}/packages/example`), current);
    }),
);

it.effect("does not retire an alias that has been remapped to another checkout", () =>
  Effect.gen(function* () {
    const original = "/workspace/retired-remap-original";
    const replacement = "/workspace/retired-remap-replacement";
    const remappedAlias = "/workspace/retired-remap-alias";
    const retiredAlias = "/workspace/retired-remap-unused";
    yield* registerWorkspaceLeaseRoot(original, [remappedAlias, retiredAlias]);
    yield* registerWorkspaceLeaseRoot(replacement, [remappedAlias]);
    yield* retireWorkspaceLeaseAliases(original, [remappedAlias, retiredAlias, replacement]);
    assert.equal(
      yield* resolveWorkspaceLeaseRoot(`${remappedAlias}/packages/example`),
      replacement,
    );
    assert.equal(yield* resolveWorkspaceLeaseRoot(`${replacement}/packages/example`), replacement);
    assert.equal(yield* resolveWorkspaceLeaseRoot(`${original}/packages/example`), original);
    assert.equal(yield* resolveWorkspaceLeaseRoot(retiredAlias), retiredAlias);
  }),
);

it.effect("allows the owning fiber to nest leases for the same resolved workspace", () =>
  Effect.gen(function* () {
    const value = yield* withWorkspaceLease(
      "/workspace/nested-lease",
      withWorkspaceLease("/workspace/other/../nested-lease", Effect.succeed("nested")),
    );
    assert.strictEqual(value, "nested");
  }),
);

it.effect("keeps a child fiber waiting until the outermost lease releases", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cwd = "/workspace/child-lease";
    const child = yield* withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        const child = yield* withWorkspaceLease(cwd, Deferred.succeed(entered, undefined)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isFalse(yield* Deferred.isDone(entered));
        yield* withWorkspaceLease(cwd, Effect.void);
        // Returning from a nested call must not release the outer holder.
        assert.isFalse(yield* Deferred.isDone(entered));
        return child;
      }),
    );
    yield* Deferred.await(entered);
    yield* Fiber.join(child);
  }),
);

it.effect("releases a failed nested lease to a queued fiber", () =>
  Effect.gen(function* () {
    const cwd = "/workspace/failed-lease";
    const entered = yield* Deferred.make<void>();
    const fail = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      cwd,
      withWorkspaceLease(
        cwd,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(fail)),
          Effect.andThen(Effect.fail("startup failed")),
        ),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const waiterEntered = yield* Deferred.make<void>();
    const waiter = yield* withWorkspaceLease(cwd, Deferred.succeed(waiterEntered, undefined)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isFalse(yield* Deferred.isDone(waiterEntered));
    yield* Deferred.succeed(fail, undefined);
    assert.strictEqual(yield* Fiber.join(holder).pipe(Effect.flip), "startup failed");
    yield* Deferred.await(waiterEntered);
    yield* Fiber.join(waiter);
    assert.strictEqual(yield* withWorkspaceLease(cwd, Effect.succeed("reopened")), "reopened");
  }),
);

it.effect("cancels a waiter without separating the remaining waiters from their holder", () =>
  Effect.gen(function* () {
    const cwd = "/workspace/cancelled-lease";
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      cwd,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const cancelled = yield* withWorkspaceLease(cwd, Effect.void).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Fiber.interrupt(cancelled);
    const waiterEntered = yield* Deferred.make<void>();
    const waiter = yield* withWorkspaceLease(cwd, Deferred.succeed(waiterEntered, undefined)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isFalse(yield* Deferred.isDone(waiterEntered));
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(waiterEntered);
    yield* Fiber.joinAll([holder, waiter]);
  }),
);

it.effect("releases an interrupted holder to its queued waiter", () =>
  Effect.gen(function* () {
    const cwd = "/workspace/interrupted-lease";
    const entered = yield* Deferred.make<void>();
    const hold = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      cwd,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const waiterEntered = yield* Deferred.make<void>();
    const waiter = yield* withWorkspaceLease(cwd, Deferred.succeed(waiterEntered, undefined)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isFalse(yield* Deferred.isDone(waiterEntered));
    yield* Fiber.interrupt(holder);
    yield* Deferred.await(waiterEntered);
    yield* Fiber.join(waiter);
  }),
);
