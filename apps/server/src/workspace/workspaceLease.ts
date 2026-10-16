import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number; ownerFiberId: number | null }
>();

/** Coordinates checkout removal and startup across threads using the same resolved cwd. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Path.Path.pipe(
      Effect.map((path) => path.resolve(cwd)),
      Effect.provide(NodePath.layer),
    ),
    (workspacePath) =>
      Effect.withFiber((fiber) => {
        const lease = leases.get(workspacePath) ?? {
          semaphore: Semaphore.makeUnsafe(1),
          users: 0,
          ownerFiberId: null,
        };
        // Nested startup services share the caller's lease. A child fiber has its
        // own id and must wait, even when it inherited the caller's context.
        if (lease.ownerFiberId === fiber.id) return effect;
        leases.set(workspacePath, lease);
        lease.users++;
        return lease.semaphore
          .withPermit(
            Effect.acquireUseRelease(
              Effect.sync(() => {
                lease.ownerFiberId = fiber.id;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  lease.ownerFiberId = null;
                }),
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                lease.users--;
                if (lease.users === 0) leases.delete(workspacePath);
              }),
            ),
          );
      }),
  );
