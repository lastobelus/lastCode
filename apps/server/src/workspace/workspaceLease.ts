import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Coordinates checkout removal and startup across threads using the same resolved cwd. */
export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const workspacePath = NodePath.resolve(cwd);
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
  });
