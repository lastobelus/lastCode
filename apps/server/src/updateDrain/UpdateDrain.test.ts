import { CommandId, UpdateDrainRequestId, UpdateDrainTargetVersion } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { UpdateDrainRepositoryLive } from "../persistence/Layers/UpdateDrainRepository.ts";
import { UpdateDrainRepository } from "../persistence/Services/UpdateDrainRepository.ts";
import { UpdateDrain, layer, makeUpdateDrain } from "./UpdateDrain.ts";

const repositoryLayer = UpdateDrainRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const testLayer = layer.pipe(Layer.provideMerge(repositoryLayer));
const tests = it.layer(testLayer);

const requestId = UpdateDrainRequestId.make("update-1");
const targetVersion = UpdateDrainTargetVersion.make("1.2.3");
const startedAt = "2026-08-21T00:00:00.000Z";

tests("UpdateDrain", (it) => {
  it.effect("returns persisted receipts and restores the projected state", () =>
    Effect.gen(function* () {
      const drain = yield* UpdateDrain;
      const repository = yield* UpdateDrainRepository;
      const startCommand = {
        type: "update-drain.start" as const,
        commandId: CommandId.make("start-1"),
        requestId,
        targetVersion,
        createdAt: startedAt,
      };

      const started = yield* drain.dispatch(startCommand);
      assert.deepStrictEqual(started, {
        commandId: startCommand.commandId,
        requestId,
        commandType: "update-drain.start",
        targetVersion,
        acceptedAt: startedAt,
        resultSequence: 1,
        status: "accepted",
        errorReason: null,
        error: null,
      });
      assert.deepStrictEqual(yield* drain.status, {
        sequence: 1,
        intent: { requestId, targetVersion, status: "draining" },
      });

      const replayed = yield* drain.dispatch(startCommand);
      assert.deepStrictEqual(replayed, started);

      const cancelled = yield* drain.dispatch({
        type: "update-drain.cancel",
        commandId: CommandId.make("cancel-1"),
        requestId,
        createdAt: "2026-08-21T00:01:00.000Z",
      });
      assert.equal(cancelled.resultSequence, 2);

      const restored = yield* makeUpdateDrain().pipe(
        Effect.provideService(UpdateDrainRepository, repository),
      );
      assert.deepStrictEqual(yield* restored.status, {
        sequence: 2,
        intent: { requestId, targetVersion, status: "cancelled" },
      });
    }),
  );

  it.effect("persists rejected receipts and rejects command-id conflicts", () =>
    Effect.gen(function* () {
      const drain = yield* UpdateDrain;
      const activeRequestId = UpdateDrainRequestId.make("update-active");
      yield* drain.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-active"),
        requestId: activeRequestId,
        targetVersion,
        createdAt: startedAt,
      });

      const rejectedCommand = {
        type: "update-drain.start" as const,
        commandId: CommandId.make("start-competing"),
        requestId: UpdateDrainRequestId.make("update-2"),
        targetVersion: UpdateDrainTargetVersion.make("1.2.4"),
        createdAt: startedAt,
      };
      const rejected = yield* Effect.result(drain.dispatch(rejectedCommand));
      const retried = yield* Effect.result(drain.dispatch(rejectedCommand));
      assert.equal(rejected._tag, "Failure");
      assert.equal(retried._tag, "Failure");
      assert.equal(
        rejected._tag === "Failure" ? rejected.failure.reason : null,
        "already_draining",
      );
      assert.equal(retried._tag === "Failure" ? retried.failure.reason : null, "already_draining");

      const conflict = yield* Effect.result(
        drain.dispatch({
          ...rejectedCommand,
          requestId: UpdateDrainRequestId.make("different-input"),
        }),
      );
      assert.equal(conflict._tag, "Failure");
      assert.equal(
        conflict._tag === "Failure" ? conflict.failure.reason : null,
        "command_id_conflict",
      );
    }),
  );
});

it.layer(testLayer)("UpdateDrain activation claim", (it) => {
  it.effect("restores an activation claim and replays its receipt after restart", () =>
    Effect.gen(function* () {
      const drain = yield* UpdateDrain;
      const repository = yield* UpdateDrainRepository;
      yield* drain.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("claim-start"),
        requestId,
        targetVersion,
        createdAt: startedAt,
      });
      const claimCommand = {
        type: "update-drain.claim" as const,
        commandId: CommandId.make(`update-drain:claim:${requestId}`),
        requestId,
        createdAt: "2026-08-21T00:01:00.000Z",
      };
      const claimed = yield* drain.dispatch(claimCommand);

      const restored = yield* makeUpdateDrain().pipe(
        Effect.provideService(UpdateDrainRepository, repository),
      );
      assert.deepStrictEqual(yield* restored.status, {
        sequence: 2,
        intent: { requestId, targetVersion, status: "claimed" },
      });
      assert.deepStrictEqual(yield* restored.dispatch(claimCommand), claimed);
    }),
  );
});

it.layer(testLayer)("UpdateDrain request history", (it) => {
  it.effect("never reuses a cancelled request id after later drains and restart", () =>
    Effect.gen(function* () {
      const drain = yield* UpdateDrain;
      const repository = yield* UpdateDrainRepository;
      const laterRequestId = UpdateDrainRequestId.make("update-2");
      const laterTargetVersion = UpdateDrainTargetVersion.make("1.2.4");

      yield* drain.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-1"),
        requestId,
        targetVersion,
        createdAt: startedAt,
      });
      yield* drain.dispatch({
        type: "update-drain.cancel",
        commandId: CommandId.make("cancel-1"),
        requestId,
        createdAt: "2026-08-21T00:01:00.000Z",
      });
      yield* drain.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-2"),
        requestId: laterRequestId,
        targetVersion: laterTargetVersion,
        createdAt: "2026-08-21T00:02:00.000Z",
      });
      yield* drain.dispatch({
        type: "update-drain.cancel",
        commandId: CommandId.make("cancel-2"),
        requestId: laterRequestId,
        createdAt: "2026-08-21T00:03:00.000Z",
      });

      const restored = yield* makeUpdateDrain().pipe(
        Effect.provideService(UpdateDrainRepository, repository),
      );
      const staleStart = yield* Effect.result(
        restored.dispatch({
          type: "update-drain.start",
          commandId: CommandId.make("start-1-again"),
          requestId,
          targetVersion,
          createdAt: "2026-08-21T00:04:00.000Z",
        }),
      );

      assert.equal(staleStart._tag, "Failure");
      assert.equal(
        staleStart._tag === "Failure" ? staleStart.failure.reason : null,
        "request_already_cancelled",
      );
      assert.deepStrictEqual(yield* restored.status, {
        sequence: 4,
        intent: {
          requestId: laterRequestId,
          targetVersion: laterTargetVersion,
          status: "cancelled",
        },
      });
    }),
  );
});

it.layer(repositoryLayer)("UpdateDrain interruption safety", (it) => {
  it.effect("projects an accepted event before honoring interruption", () =>
    Effect.gen(function* () {
      const repository = yield* UpdateDrainRepository;
      const committed = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const interruptedRepository = UpdateDrainRepository.of({
        ...repository,
        commitAccepted: (input) =>
          repository.commitAccepted(input).pipe(
            Effect.tap(() => Deferred.succeed(committed, undefined)),
            Effect.tap(() => Deferred.await(releaseCommit)),
          ),
      });
      const drain = yield* makeUpdateDrain().pipe(
        Effect.provideService(UpdateDrainRepository, interruptedRepository),
      );

      const dispatchFiber = yield* drain
        .dispatch({
          type: "update-drain.start",
          commandId: CommandId.make("interrupted-start"),
          requestId,
          targetVersion,
          createdAt: startedAt,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      dispatchFiber.interruptUnsafe();
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.await(dispatchFiber);

      assert.deepStrictEqual(yield* drain.status, {
        sequence: 1,
        intent: { requestId, targetVersion, status: "draining" },
      });
    }),
  );
});
