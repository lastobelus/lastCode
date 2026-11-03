import {
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ActionResumeState,
  type EnvironmentPauseStatus,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { actionResumeStatus } from "@t3tools/shared/actionResume";
import { describe, expect, it } from "vite-plus/test";

import {
  actionResumeEnvironmentPaused,
  actionResumeWait,
  childActionResumeContext,
  threadActionResumeContext,
} from "./actionResume.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const action: ActionResumeState = {
  runId: "action-1",
  threadId: v2ThreadShell.id,
  projectId: v2ThreadShell.projectId,
  actionId: "check",
  actionName: "Check",
  terminalId: "terminal-1",
  outcome: "succeeded",
  delivery: "delivered",
  startedAt: "2026-06-20T00:00:00.000Z",
  finishedAt: "2026-06-20T00:00:01.000Z",
  exitCode: 0,
  exitSignal: null,
};
const followUp: OrchestrationV2Run = {
  id: RunId.make("follow-up"),
  threadId: v2ThreadShell.id,
  ordinal: 1,
  providerInstanceId: v2ThreadShell.providerInstanceId,
  modelSelection: v2ThreadShell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("action-resume:action-1:follow-up"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "queued",
  requestedAt: v2Now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const request: OrchestrationV2RuntimeRequest = {
  id: RuntimeRequestId.make("request"),
  nodeId: NodeId.make("unrelated-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: v2Now,
  resolvedAt: null,
};
const projection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, actionResume: action },
  runs: [followUp],
};

function statusOf(input: Parameters<typeof threadActionResumeContext>[0]) {
  const context = threadActionResumeContext(input);
  expect(context).not.toBeNull();
  return actionResumeStatus({ ...context!, environmentPaused: false });
}

describe("threadActionResumeContext", () => {
  it("selects only the exact continuation despite newer unrelated work", () => {
    const unrelated = {
      ...followUp,
      id: RunId.make("newer"),
      ordinal: 2,
      userMessageId: MessageId.make("action-resume:other:follow-up"),
      status: "running" as const,
    };
    const context = threadActionResumeContext({ ...projection, runs: [followUp, unrelated] });
    expect(context?.followUp).toEqual({ status: "queued", queueHeld: undefined });
    expect(statusOf({ ...projection, runs: [unrelated] }).state).toBe("follow_up_dispatched");
  });

  it("rejects absent or inherited Actions", () => {
    expect(threadActionResumeContext(v2Projection)).toBeNull();
    expect(
      threadActionResumeContext({
        ...projection,
        thread: {
          ...projection.thread,
          actionResume: { ...action, threadId: ThreadId.make("parent") },
        },
      }),
    ).toBeNull();
  });

  it("keeps queue holds and any pending request as distinct barriers", () => {
    expect(statusOf({ ...projection, runs: [{ ...followUp, queueHeld: true }] }).state).toBe(
      "attention_required",
    );
    expect(statusOf({ ...projection, runtimeRequests: [request] }).state).toBe("waiting_for_input");
    expect(
      statusOf({ ...projection, runtimeRequests: [{ ...request, status: "resolved" }] }).state,
    ).toBe("follow_up_queued");
  });

  it.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "recognizes the exact %s continuation as ended",
    (status) => {
      expect(statusOf({ ...projection, runs: [{ ...followUp, status }] }).state).toBe(
        "follow_up_ended",
      );
    },
  );

  it("uses current pause rather than retained pause intent", () => {
    const context = threadActionResumeContext({
      ...projection,
      thread: {
        ...projection.thread,
        actionResume: { ...action, delivery: "pending", heldByEnvironmentPause: true },
      },
      runs: [],
    })!;
    expect(actionResumeStatus({ ...context, environmentPaused: true }).state).toBe(
      "environment_paused",
    );
    expect(actionResumeStatus({ ...context, environmentPaused: false }).state).toBe(
      "pending_delivery",
    );
    expect(
      actionResumeStatus({ ...context, environmentPaused: false, hasPendingRequest: true }).state,
    ).toBe("waiting_for_input");
  });
});

describe("childActionResumeContext", () => {
  it.each(["armed", "pending", "available"] as const)(
    "exposes own %s Action without inferring a run",
    (delivery) => {
      const context = childActionResumeContext({
        ...v2ThreadShell,
        actionResume: {
          ...action,
          delivery,
          outcome: delivery === "armed" ? "running" : "succeeded",
        },
        latestRunId: followUp.id,
        activeRunId: followUp.id,
        pendingRuntimeRequest: {
          id: request.id,
          kind: request.kind,
          createdAt: v2Now,
          blocking: false,
        },
      });
      expect(context).toMatchObject({
        action: { delivery },
        followUp: null,
        hasPendingRequest: true,
      });
    },
  );

  it.each(["delivered", "disposed"] as const)("hides %s child state", (delivery) => {
    expect(
      childActionResumeContext({ ...v2ThreadShell, actionResume: { ...action, delivery } }),
    ).toBeNull();
  });

  it("rejects missing and parent-owned Actions", () => {
    expect(childActionResumeContext(v2ThreadShell)).toBeNull();
    expect(
      childActionResumeContext({
        ...v2ThreadShell,
        actionResume: {
          ...action,
          delivery: "pending",
          threadId: ThreadId.make("parent"),
        },
      }),
    ).toBeNull();
  });
});

describe("actionResumeEnvironmentPaused", () => {
  const status: EnvironmentPauseStatus = {
    session: null,
    activeThreadCount: 0,
    blockers: [],
    quiet: true,
    observation: "known",
  };
  const input = { connected: true, supported: true, known: true, status };
  it.each(["pausing", "paused", "resuming"] as const)("derives the %s delivery hold", (phase) => {
    expect(
      actionResumeEnvironmentPaused({
        ...input,
        status: {
          ...status,
          session: { id: "pause", createdAt: action.startedAt, phase, targets: [] },
        },
      }),
    ).toBe(phase !== "resuming");
  });
  it("handles no session, unsupported, unknown and disconnected observations", () => {
    expect(actionResumeEnvironmentPaused(input)).toBe(false);
    expect(actionResumeEnvironmentPaused({ ...input, supported: false, status: null })).toBe(false);
    expect(actionResumeEnvironmentPaused({ ...input, known: false })).toBeNull();
    expect(actionResumeEnvironmentPaused({ ...input, connected: false })).toBeNull();
    expect(actionResumeEnvironmentPaused({ ...input, status: null })).toBeNull();
    expect(
      actionResumeEnvironmentPaused({ ...input, status: { ...status, observation: "unknown" } }),
    ).toBeNull();
  });
});

describe("actionResumeWait", () => {
  it("hides a delivered ended continuation even when pause observation is unknown", () => {
    const context = {
      action,
      followUp: { status: "completed" as const, queueHeld: false },
      hasPendingRequest: false,
    };
    expect(actionResumeWait(context, action, null).presentation).toBeNull();
    expect(actionResumeWait(context, action, null).status).toBeNull();
  });
  it("preserves available result recovery even if its previous continuation ended", () => {
    const available = { ...action, delivery: "available" as const };
    const context = {
      action: available,
      followUp: { status: "failed" as const, queueHeld: false },
      hasPendingRequest: false,
    };
    expect(actionResumeWait(context, available, false).presentation).not.toBeNull();
    expect(actionResumeWait(context, available, false).status?.attentionRequired).toBe(true);
  });
  it("does not use a different Action's continuation to hide the current wait", () => {
    const context = {
      action: { ...action, runId: "older" },
      followUp: { status: "completed" as const, queueHeld: false },
      hasPendingRequest: true,
    };
    expect(actionResumeWait(context, action, false).presentation).not.toBeNull();
    expect(actionResumeWait(context, action, false).status?.state).toBe("follow_up_dispatched");
  });
});
