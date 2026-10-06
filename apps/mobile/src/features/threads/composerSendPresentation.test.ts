import { recoveryQueuesFollowUps } from "@t3tools/client-runtime/state/thread-recovery";
import { RunAttemptId, RunId, type OrchestrationV2ThreadRecovery } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  forceQueue: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

function recovery(status: OrchestrationV2ThreadRecovery["status"]): OrchestrationV2ThreadRecovery {
  return {
    runId: RunId.make("recovering-run"),
    attemptId: RunAttemptId.make("recovering-attempt"),
    status,
    detail: "The provider's turn is being checked.",
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  };
}

describe("resolveComposerSendPresentation", () => {
  it("sends plainly while the thread is idle", () => {
    const presentation = resolveComposerSendPresentation(idle);

    expect(presentation.label).toBe("Send");
    expect(presentation.icon).toBe("arrow.up");
    expect(presentation.offersFollowUpChoice).toBe(false);
    expect(presentation.action).toBeNull();
  });

  it("says Queue while the outbox is holding the message back", () => {
    expect(resolveComposerSendPresentation({ ...idle, deliveryDeferred: true }).label).toBe(
      "Queue",
    );
  });

  it("follows the configured behavior once a turn is running", () => {
    const queueing = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "queue",
    });
    const steering = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "steer",
    });

    expect(queueing.label).toBe("Queue");
    expect(queueing.icon).toBe("list.number");
    expect(queueing.action).toBe("queue");
    expect(queueing.alternate).toBe("steer");
    expect(steering.label).toBe("Steer");
    expect(steering.icon).toBe("arrow.turn.left.up");
    expect(steering.action).toBe("steer");
    expect(steering.alternate).toBe("queue");
    expect(steering.offersFollowUpChoice).toBe(true);
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });

  it.each(["suspect", "stale", "recovering", "failed"] as const)(
    "queues follow-ups without a steer choice during %s recovery",
    (status) => {
      const incident = recovery(status);
      for (const running of [true, false]) {
        const presentation = resolveComposerSendPresentation({
          ...idle,
          running,
          canSteer: true,
          followUpBehavior: "steer",
          forceQueue: recoveryQueuesFollowUps(incident, incident.runId),
        });

        expect(presentation.label).toBe("Queue");
        expect(presentation.icon).toBe("list.number");
        expect(presentation.action).toBe("queue");
        expect(presentation.alternate).toBeNull();
        expect(presentation.offersFollowUpChoice).toBe(false);
      }
    },
  );

  it("restores ordinary send choices after recovery or when another run is active", () => {
    const recovered = recovery("recovered");
    const previousIncident = recovery("failed");
    for (const forceQueue of [
      recoveryQueuesFollowUps(recovered, recovered.runId),
      recoveryQueuesFollowUps(previousIncident, RunId.make("new-run")),
      recoveryQueuesFollowUps(previousIncident, null),
    ]) {
      const presentation = resolveComposerSendPresentation({
        ...idle,
        running: true,
        canSteer: true,
        followUpBehavior: "steer",
        forceQueue,
      });

      expect(presentation.label).toBe("Steer");
      expect(presentation.action).toBe("steer");
      expect(presentation.alternate).toBe("queue");
      expect(presentation.offersFollowUpChoice).toBe(true);
      expect(resolveComposerSendPresentation({ ...idle, forceQueue }).label).toBe("Send");
    }
  });

  it("keeps the save affordance while a queued message is being edited", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      editingQueuedMessage: true,
      running: true,
      canSteer: true,
      followUpBehavior: "steer",
      forceQueue: true,
    });

    expect(presentation.label).toBe("Update queued message");
    expect(presentation.icon).toBe("checkmark");
    expect(presentation.action).toBeNull();
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
