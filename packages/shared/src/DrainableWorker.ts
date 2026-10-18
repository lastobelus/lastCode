import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;

  readonly drain: Effect.Effect<void>;

  /**
   * Stop the worker after its current queue has been drained.
   *
   * Callers that coordinate access to a worker may use this to retire idle
   * keyed workers before their parent scope closes.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * A finalizer shuts down the queue and drops queued items, so `drain` resolves after the scope
 * closes instead of waiting on them. An item that fails or dies is logged and skipped; the worker
 * keeps processing later items and `drain` still resolves.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void).pipe(Effect.ignore));
    const outstanding = yield* TxRef.make(0);
    const queue = yield* TxQueue.unbounded<A>();
    yield* Scope.addFinalizer(
      workerScope,
      // Uncount only the dropped items: an item still running uncounts itself.
      TxQueue.clear(queue).pipe(
        Effect.flatMap((dropped) => TxRef.update(outstanding, (n) => n - dropped.length)),
        Effect.andThen(TxQueue.shutdown(queue)),
        Effect.tx,
      ),
    );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((a) =>
        // `suspend` turns a `process` that throws while building its effect
        // into this item's defect instead of the loop's.
        Effect.suspend(() => process(a)).pipe(
          // Only the item's own failure, defect, or interruption lands here and
          // the loop continues; interrupting the worker fiber still stops it.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("DrainableWorker item failed", cause),
          ),
          Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
        ),
      ),
      Effect.forever,
      Effect.forkIn(workerScope),
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<void, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap((accepted) =>
          accepted ? TxRef.update(outstanding, (n) => n + 1) : Effect.void,
        ),
        Effect.asVoid,
        Effect.tx,
      );

    // Closing the child scope interrupts the worker and shuts down the queue.
    // The parent scope also closes it, and Scope.close is idempotent.
    const shutdown = Scope.close(workerScope, Exit.void).pipe(Effect.ignore);

    return { enqueue, drain, shutdown } satisfies DrainableWorker<A>;
  });
