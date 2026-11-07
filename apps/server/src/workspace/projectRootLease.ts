import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const projectRoots = Semaphore.makeUnsafe(1);

/** Serialize project-root claims with the final isolation and removal of a workspace. */
export const withProjectRootLease = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  projectRoots.withPermit(effect);
