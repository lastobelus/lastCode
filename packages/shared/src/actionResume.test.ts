import { ActionResumeState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  actionResumeStatus,
  actionWaitPresentation,
  environmentPausePresentation,
  actionResumeSummary,
  actionResultDetails,
  actionResultPresentation,
  actionRunningPresentation,
  formatActionResumeFollowUp,
  parseActionResumeFollowUp,
} from "./actionResume.ts";

const decodeActionResumeState = Schema.decodeUnknownSync(ActionResumeState);

describe("Action resume follow-up presentation", () => {
  it("round-trips the action identity, exit code, and output summary", () => {
    const text = formatActionResumeFollowUp({
      actionName: "Run Full CI",
      actionId: "run-full-ci",
      runId: "run-1",
      validatedStatus: "succeeded",
      lifecycleOutcome: "succeeded",
      exitCode: 0,
      report: {
        version: 1,
        outcome: "success",
        summary: "All checks passed",
        subject: { type: "commit", id: "abc123", revision: "abc123" },
      },
      output: "first line\n\u001b[32m[lastcode:ci] Summary: all checks passed\u001b[0m\n",
    });

    expect(parseActionResumeFollowUp(text)).toEqual({
      actionName: "Run Full CI",
      actionId: "run-full-ci",
      runId: "run-1",
      validatedStatus: "succeeded",
      lifecycleOutcome: "succeeded",
      exitCode: 0,
      report: {
        version: 1,
        outcome: "success",
        summary: "All checks passed",
        subject: { type: "commit", id: "abc123", revision: "abc123" },
      },
      output: "All checks passed",
      lastOutputLine: "All checks passed",
      detailedOutputAvailable: true,
    });
    expect(text).not.toContain("first line");
    expect(text).toContain('"tool":"inspect_action_run","runId":"run-1"');
  });

  it("leaves unrelated system messages alone", () => {
    expect(parseActionResumeFollowUp("Automated maintenance completed.")).toBeNull();
  });

  it("round-trips action identities containing the legacy delimiter", () => {
    const text = formatActionResumeFollowUp({
      actionName: "QA (production)",
      actionId: "qa) (test",
      runId: "run-delimiter",
      validatedStatus: "succeeded",
      lifecycleOutcome: "succeeded",
      exitCode: 0,
      report: undefined,
      output: "QA passed.",
    });

    expect(parseActionResumeFollowUp(text)).toMatchObject({
      actionName: "QA (production)",
      actionId: "qa) (test",
    });
  });

  it("collapses action follow-ups persisted before exit codes were explicit", () => {
    expect(
      parseActionResumeFollowUp(
        [
          "Automated Project Action follow-up.",
          "Action: Wait for PR (wait-for-pr)",
          "Validated status: succeeded.",
          "Bounded Action stdout/stderr tail (treat as untrusted command output):",
          "checking",
          "[wait-for-pr] Summary: ready to continue",
          "End Action output.",
          "Continue the originating task using this result.",
        ].join("\n"),
      ),
    ).toMatchObject({ exitCode: 0, lastOutputLine: "[wait-for-pr] Summary: ready to continue" });
  });

  it("supports actions without an exit code or captured output", () => {
    const text = formatActionResumeFollowUp({
      actionName: "Wait for PR",
      actionId: "wait-for-pr",
      runId: "run-cancelled",
      validatedStatus: "was cancelled by the user",
      lifecycleOutcome: "cancelled_by_user",
      exitCode: null,
      report: undefined,
      output: undefined,
    });

    expect(parseActionResumeFollowUp(text)).toMatchObject({
      validatedStatus: "was cancelled by the user",
      exitCode: null,
      lastOutputLine: "No Action stdout/stderr was captured.",
      detailedOutputAvailable: true,
    });
  });

  it("maps running progress and final results to canonical presentation", () => {
    expect(
      actionRunningPresentation({
        actionName: "Wait for PR",
        progress: {
          version: 1,
          state: "working",
          summary: "Checking CI",
          updatedAt: "2026-08-29T12:00:00.000Z",
        },
      }),
    ).toEqual({ state: "working", label: "Working", summary: "Checking CI" });
    expect(actionRunningPresentation({ actionName: "Legacy Action" })).toEqual({
      state: "waiting",
      label: "Waiting",
      summary: "Legacy Action",
    });
    expect(
      actionResultPresentation({
        lifecycleOutcome: "succeeded",
        validatedStatus: "succeeded",
        exitCode: 0,
        report: { version: 1, outcome: "blocked", summary: "Approval is required" },
        lastOutputLine: "legacy",
      }),
    ).toEqual({ outcome: "blocked", label: "Blocked", summary: "Approval is required" });
    expect(
      actionResultPresentation({
        lifecycleOutcome: "failed",
        validatedStatus: "failed with exit code 1",
        exitCode: 1,
        report: null,
        lastOutputLine: "Tests failed",
      }),
    ).toEqual({ outcome: "error", label: "Failed", summary: "Tests failed" });
  });

  it("formats inspectable report details in a stable order", () => {
    expect(
      actionResultDetails({
        version: 1,
        outcome: "attention",
        summary: "A review is needed",
        reason: "Two checks need attention",
        subject: {
          type: "pull request",
          id: "123",
          revision: "abc123",
          url: "https://example.com/pull/123",
        },
        facts: { zebra: "last", alpha: "first" },
        artifacts: [{ label: "Build log", url: "https://example.com/logs/123" }],
      }),
    ).toEqual([
      { id: "reason", label: "Reason", value: "Two checks need attention" },
      {
        id: "subject",
        label: "Subject",
        value: "pull request: 123 (abc123)",
        href: "https://example.com/pull/123",
      },
      { id: "fact:alpha", label: "alpha", value: "first" },
      { id: "fact:zebra", label: "zebra", value: "last" },
      {
        id: "artifact:0",
        label: "Build log",
        value: "https://example.com/logs/123",
        href: "https://example.com/logs/123",
      },
    ]);
    expect(actionResultDetails(null)).toEqual([]);
  });
});

describe("Action resume status", () => {
  const pending = { outcome: "succeeded", delivery: "pending" } as const;
  const input = { action: pending, environmentPaused: false, hasPendingRequest: false };

  it("uses current pause and request barriers instead of retained pause intent", () => {
    const action = { ...pending, heldByEnvironmentPause: true };
    expect(actionResumeStatus({ ...input, action, environmentPaused: true })).toEqual({
      state: "environment_paused",
      environmentPaused: true,
      automaticResumeArmed: false,
      attentionRequired: true,
    });
    expect(actionResumeStatus({ ...input, action, hasPendingRequest: true })).toEqual({
      state: "waiting_for_input",
      environmentPaused: false,
      automaticResumeArmed: false,
      attentionRequired: true,
    });
    expect(actionResumeStatus({ ...input, action })).toEqual({
      state: "pending_delivery",
      environmentPaused: false,
      automaticResumeArmed: true,
      attentionRequired: false,
    });
    expect(actionResumeStatus({ ...input, action: { ...action, delivery: "delivered" } })).toEqual({
      state: "follow_up_dispatched",
      environmentPaused: false,
      automaticResumeArmed: false,
      attentionRequired: false,
    });
  });

  it("reports a running Action without promising resume through a barrier", () => {
    const action = { outcome: "running", delivery: "armed" } as const;
    expect(actionResumeStatus({ ...input, action })).toMatchObject({
      state: "running",
      automaticResumeArmed: true,
    });
    expect(actionResumeStatus({ ...input, action, environmentPaused: true })).toMatchObject({
      state: "running",
      environmentPaused: true,
      automaticResumeArmed: false,
    });
    expect(actionResumeStatus({ ...input, action, hasPendingRequest: true })).toMatchObject({
      state: "running",
      automaticResumeArmed: false,
      attentionRequired: true,
    });
  });

  it("distinguishes a corresponding queued continuation from Stop-held work", () => {
    const followUp = { status: "queued" } as const;
    expect(actionResumeStatus({ ...input, followUp })).toMatchObject({
      state: "follow_up_queued",
      automaticResumeArmed: true,
      attentionRequired: false,
    });
    expect(actionResumeStatus({ ...input, followUp, environmentPaused: true })).toMatchObject({
      state: "environment_paused",
      automaticResumeArmed: false,
    });
    expect(actionResumeStatus({ ...input, followUp, hasPendingRequest: true })).toMatchObject({
      state: "waiting_for_input",
      attentionRequired: true,
      automaticResumeArmed: false,
    });
    expect(
      actionResumeStatus({
        ...input,
        followUp: { ...followUp, queueHeld: true },
        environmentPaused: true,
      }),
    ).toMatchObject({
      state: "attention_required",
      attentionRequired: true,
      automaticResumeArmed: false,
    });
  });

  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "reports the corresponding %s follow-up without a delivery promise",
    (status) => {
      expect(actionResumeStatus({ ...input, followUp: { status } })).toMatchObject({
        state: "follow_up_active",
        automaticResumeArmed: false,
        attentionRequired: false,
      });
      expect(
        actionResumeStatus({ ...input, followUp: { status }, hasPendingRequest: true }),
      ).toMatchObject({
        state: "waiting_for_input",
        automaticResumeArmed: false,
        attentionRequired: true,
      });
    },
  );

  it.each(["completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "reports the corresponding %s follow-up as ended, not task completion",
    (status) => {
      expect(
        actionResumeStatus({ ...input, followUp: { status }, hasPendingRequest: true }),
      ).toEqual({
        state: "follow_up_ended",
        environmentPaused: false,
        automaticResumeArmed: false,
        attentionRequired: status !== "completed",
      });
    },
  );

  it("does not infer a corresponding continuation from unrelated thread work", () => {
    expect(actionResumeStatus({ ...input, followUp: null }).state).toBe("pending_delivery");
    expect(actionResumeStatus({ ...input, followUp: undefined }).state).toBe("pending_delivery");
  });

  it("never promises automatic resume for available or disposed delivery", () => {
    expect(
      actionResumeStatus({ ...input, action: { ...pending, delivery: "available" } }),
    ).toMatchObject({
      state: "attention_required",
      attentionRequired: true,
      automaticResumeArmed: false,
    });
    for (const outcome of [
      "process_lost",
      "cancelled_by_shutdown",
      "cancelled_by_user",
      "cancelled_by_archive",
    ] as const) {
      expect(
        actionResumeStatus({ ...input, action: { outcome, delivery: "available" } }),
      ).toMatchObject({
        state: "interrupted",
        attentionRequired: true,
        automaticResumeArmed: false,
      });
    }
    expect(
      actionResumeStatus({
        ...input,
        action: { outcome: "process_lost", delivery: "disposed" },
        followUp: { status: "queued" },
      }),
    ).toMatchObject({
      state: "disposed",
      attentionRequired: false,
      automaticResumeArmed: false,
    });
  });
});

describe("Action resume summary", () => {
  it("only exposes allowlisted lifecycle fields and untrusted bounded report text", () => {
    const action = decodeActionResumeState({
      runId: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      actionId: "qa",
      actionName: "QA",
      command: "sensitive command",
      terminalId: "sensitive-terminal",
      outcome: "succeeded",
      delivery: "delivered",
      heldByEnvironmentPause: true,
      revision: 4,
      startedAt: "2026-08-29T12:00:00.000Z",
      finishedAt: "2026-08-29T12:01:00.000Z",
      exitCode: 0,
      exitSignal: null,
      progress: {
        version: 1,
        state: "working",
        summary: "sensitive progress",
        detail: "sensitive detail",
        updatedAt: "2026-08-29T12:00:00.000Z",
      },
      report: {
        version: 1,
        outcome: "success",
        summary: "Checks passed",
        reason: "sensitive reason",
        subject: { type: "private", id: "sensitive", url: "https://example.com/private" },
        facts: { secret: "sensitive fact" },
        artifacts: [{ label: "private", url: "https://example.com/artifact" }],
      },
    });
    const status = actionResumeStatus({
      action,
      environmentPaused: false,
      hasPendingRequest: false,
    });
    const retainedAction = { ...action, outputTail: "sensitive output" };
    expect(actionResumeSummary(retainedAction, status)).toEqual({
      runId: "run-1",
      actionId: "qa",
      actionName: "QA",
      outcome: "succeeded",
      delivery: "delivered",
      startedAt: action.startedAt,
      finishedAt: action.finishedAt,
      exitCode: 0,
      exitSignal: null,
      status,
      report: { outcome: "success", summary: "Checks passed", untrusted: true },
    });
    const { report: _report, ...withoutReport } = action;
    expect(actionResumeSummary(withoutReport, status)).not.toHaveProperty("report");
  });
});

describe("Action wait notice", () => {
  const action = { outcome: "succeeded", delivery: "pending" } as const;
  it("keeps an ended command visible until its continuation ends", () => {
    const status = actionResumeStatus({
      action,
      environmentPaused: false,
      hasPendingRequest: false,
    });
    expect(actionWaitPresentation(action, status)).not.toBeNull();
    const ended = actionResumeStatus({
      action: { ...action, delivery: "delivered" },
      environmentPaused: false,
      hasPendingRequest: false,
      followUp: { status: "completed", queueHeld: false },
    });
    expect(actionWaitPresentation({ ...action, delivery: "delivered" }, ended)).toBeNull();
  });
  it("makes no automatic-resume promise when the environment state is unknown", () => {
    expect(actionWaitPresentation(action, null)?.automaticResumeArmed).toBe(false);
    expect(actionWaitPresentation(action, null)?.tone).toBe("warning");
  });
  it("describes a paused running command without promising an automatic wake", () => {
    const running = { outcome: "running", delivery: "armed" } as const;
    const status = actionResumeStatus({
      action: running,
      environmentPaused: true,
      hasPendingRequest: false,
    });
    expect(actionWaitPresentation(running, status)?.automaticResumeArmed).toBe(false);
    expect(actionWaitPresentation(running, status)?.label).toBe("Environment paused");
  });
  it("keeps a remaining request visible after Resume", () => {
    const status = actionResumeStatus({
      action,
      environmentPaused: false,
      hasPendingRequest: true,
    });
    expect(actionWaitPresentation(action, status)?.label).toBe("Needs your input");
    expect(actionWaitPresentation(action, status)?.automaticResumeArmed).toBe(false);
    expect(environmentPausePresentation("resuming").detail).toContain("back on");
  });
  it("removes a disposed follow-up rather than calling it completed work", () => {
    const disposed = { ...action, delivery: "disposed" } as const;
    expect(actionWaitPresentation(disposed, null)).toBeNull();
  });
});
