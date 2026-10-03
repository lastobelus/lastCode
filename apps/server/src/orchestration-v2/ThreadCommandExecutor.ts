import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { makeKeyedSerialExecutor, type KeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedSerialExecutor<ThreadId> & {
    readonly withPersistenceLock: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(
  ThreadCommandExecutor,
  Effect.gen(function* () {
    const threads = yield* makeKeyedSerialExecutor<ThreadId>();
    const persistence = yield* Semaphore.make(1);
    return ThreadCommandExecutor.of({
      ...threads,
      withPersistenceLock: (effect) => persistence.withPermit(effect),
    });
  }),
);
