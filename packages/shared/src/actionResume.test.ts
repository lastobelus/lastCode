import { describe, expect, it } from "vite-plus/test";

import {
  actionResultPresentation,
  actionRunningPresentation,
  formatActionResumeFollowUp,
  parseActionResumeFollowUp,
} from "./actionResume.ts";

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
});
