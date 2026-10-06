import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

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
      Effect.suspend(() => {
        const lease = leases.get(workspacePath) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        leases.set(workspacePath, lease);
        lease.users++;
        return lease.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lease.users--;
              if (lease.users === 0) leases.delete(workspacePath);
            }),
          ),
        );
      }),
  );
