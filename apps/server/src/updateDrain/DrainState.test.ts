import { CommandId, UpdateDrainRequestId, UpdateDrainTargetVersion } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decideUpdateDrainCommand,
  emptyUpdateDrainState,
  projectUpdateDrainEvent,
} from "./DrainState.ts";

const requestedAt = "2026-08-21T00:00:00.000Z";
const requestId = UpdateDrainRequestId.make("update-1");
const targetVersion = UpdateDrainTargetVersion.make("1.2.3");

describe("update drain decider and projector", () => {
  it.effect("starts and cancels one durable intent without blocker state", () =>
    Effect.gen(function* () {
      const startedDraft = yield* decideUpdateDrainCommand(emptyUpdateDrainState, {
        type: "update-drain.start",
        commandId: CommandId.make("start-1"),
        requestId,
        targetVersion,
        createdAt: requestedAt,
      });
      assert.equal(startedDraft.type, "update-drain.started");
      if (startedDraft.type !== "update-drain.started") return;
      const draining = projectUpdateDrainEvent(emptyUpdateDrainState, {
        ...startedDraft,
        sequence: 1,
      });

      assert.deepStrictEqual(draining, {
        sequence: 1,
        intent: { requestId, targetVersion, status: "draining" },
      });
      assert.ok(!("blockers" in draining));

      const cancelledDraft = yield* decideUpdateDrainCommand(draining, {
        type: "update-drain.cancel",
        commandId: CommandId.make("cancel-1"),
        requestId,
        createdAt: "2026-08-21T00:01:00.000Z",
      });
      assert.equal(cancelledDraft.type, "update-drain.cancelled");
      if (cancelledDraft.type !== "update-drain.cancelled") return;
      const cancelled = projectUpdateDrainEvent(draining, {
        ...cancelledDraft,
        sequence: 2,
      });

      assert.deepStrictEqual(cancelled, {
        sequence: 2,
        intent: { requestId, targetVersion, status: "cancelled" },
      });
    }),
  );

  it.effect("rejects competing and stale request identities", () =>
    Effect.gen(function* () {
      const draining = {
        sequence: 1,
        intent: { requestId, targetVersion, status: "draining" as const },
      };
      const competing = yield* Effect.result(
        decideUpdateDrainCommand(draining, {
          type: "update-drain.start",
          commandId: CommandId.make("start-2"),
          requestId: UpdateDrainRequestId.make("update-2"),
          targetVersion: UpdateDrainTargetVersion.make("1.2.4"),
          createdAt: requestedAt,
        }),
      );
      const staleCancel = yield* Effect.result(
        decideUpdateDrainCommand(draining, {
          type: "update-drain.cancel",
          commandId: CommandId.make("cancel-2"),
          requestId: UpdateDrainRequestId.make("update-2"),
          createdAt: requestedAt,
        }),
      );

      assert.equal(competing._tag, "Failure");
      assert.equal(
        competing._tag === "Failure" ? competing.failure.reason : null,
        "already_draining",
      );
      assert.equal(staleCancel._tag, "Failure");
      assert.equal(
        staleCancel._tag === "Failure" ? staleCancel.failure.reason : null,
        "request_mismatch",
      );
    }),
  );

  it.effect("does not describe a cancelled drain as active for another request", () =>
    Effect.gen(function* () {
      const cancelled = {
        sequence: 2,
        intent: { requestId, targetVersion, status: "cancelled" as const },
      };
      const sameRequest = yield* Effect.result(
        decideUpdateDrainCommand(cancelled, {
          type: "update-drain.cancel",
          commandId: CommandId.make("cancel-again"),
          requestId,
          createdAt: requestedAt,
        }),
      );
      const otherRequest = yield* Effect.result(
        decideUpdateDrainCommand(cancelled, {
          type: "update-drain.cancel",
          commandId: CommandId.make("cancel-stale"),
          requestId: UpdateDrainRequestId.make("update-2"),
          createdAt: requestedAt,
        }),
      );

      assert.equal(
        sameRequest._tag === "Failure" ? sameRequest.failure.reason : null,
        "request_already_cancelled",
      );
      assert.equal(
        otherRequest._tag === "Failure" ? otherRequest.failure.reason : null,
        "no_active_drain",
      );
    }),
  );
});
