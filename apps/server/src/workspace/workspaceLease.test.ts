import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { withWorkspaceLease } from "./workspaceLease.ts";

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
