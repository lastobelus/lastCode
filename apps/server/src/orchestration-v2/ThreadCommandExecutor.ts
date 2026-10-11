import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    readonly withPersistenceLock: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const threads = yield* KeyedLock.make<ThreadId>();
    const persistence = yield* Semaphore.make(1);
    return ThreadCommandExecutor.of({
      ...threads,
      withPersistenceLock: (effect) => persistence.withPermit(effect),
    });
  }),
);
