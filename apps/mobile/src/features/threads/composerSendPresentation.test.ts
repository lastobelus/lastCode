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
  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
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

  it("keeps editing a queued message while recovery forces new messages to queue", () => {
    expect(
      resolveComposerSendPresentation({ ...idle, editingQueuedMessage: true, forceQueue: true }),
    ).toMatchObject({
      label: "Update queued message",
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    });
  });
});
