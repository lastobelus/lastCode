import type { ActionResumeState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerActionResumeActions,
  ComposerActionResumeDescription,
  ComposerActionResumeTitle,
  pendingActionBanner,
} from "./ComposerActionResume";
import { actionResumeStatus } from "@t3tools/shared/actionResume";

const action = {
  runId: "run-1",
  threadId: "thread-1",
  projectId: "project-1",
  actionId: "wait-for-pr",
  actionName: "Wait for PR",
  command: "vp run wait-for-pr",
  terminalId: "terminal-1",
  outcome: "running",
  delivery: "armed",
  startedAt: "2026-08-25T12:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
  progress: {
    state: "waiting",
    summary: "Waiting for Codex review",
    detail: "Watching checks and review feedback",
  },
} as ActionResumeState;

const heldAction: ActionResumeState = {
  ...action,
  outcome: "succeeded",
  delivery: "pending",
  heldByEnvironmentPause: true,
  finishedAt: "2026-08-25T12:01:00.000Z",
  exitCode: 0,
  report: {
    version: 1,
    outcome: "success",
    summary: "Documentation preview ready",
  },
};

function pendingBanner(state: ActionResumeState | null, paused = true) {
  return pendingActionBanner({
    action: state,
    status: state
      ? actionResumeStatus({ action: state, environmentPaused: paused, hasPendingRequest: false })
      : null,
    canRead: false,
    onOpenTerminal: () => undefined,
  });
}

describe("completed Action result awaiting continuation", () => {
  it("retains the result summary and wait reason without mutation controls", () => {
    const banner = pendingBanner(heldAction);
    expect(banner).toMatchObject({
      id: "action-follow-up:run-1",
      title: "Wait for PR · Environment paused",
    });
    expect(banner?.description).toContain("Succeeded: Documentation preview ready.");
    expect(banner?.description).toContain("Resume the environment");
    expect(banner?.actions).toBeUndefined();
    expect(banner?.onDismiss).toBeUndefined();
    expect(heldAction.delivery).toBe("pending");
  });

  it.each([
    null,
    action,
    { ...heldAction, outcome: "running" as const },
    ...(["available", "disposed"] as const).map((delivery) => ({ ...heldAction, delivery })),
  ])("leaves running, recovery and disposed states to their own presentation: %j", (state) => {
    expect(pendingBanner(state)).toBeNull();
  });

  it.each([
    ["succeeded", "success", "Succeeded"],
    ["succeeded", "attention", "Needs attention"],
    ["succeeded", "blocked", "Blocked"],
    ["failed", "success", "Failed"],
    ["cancelled_by_user", "success", "Cancelled"],
    ["cancelled_by_archive", "success", "Cancelled"],
    ["cancelled_by_shutdown", "success", "Cancelled"],
    ["process_lost", "success", "Interrupted"],
  ] as const)("preserves %s / %s result meaning", (outcome, reportOutcome, label) => {
    expect(
      pendingBanner({
        ...heldAction,
        outcome,
        report: { ...heldAction.report!, outcome: reportOutcome },
      })?.description,
    ).toContain(`${label}: Documentation preview ready.`);
  });

  it("identifies the result even without a retained report", () => {
    expect(pendingBanner({ ...heldAction, report: undefined })?.description).toMatch(
      /^Succeeded\./,
    );
  });

  it.each(["Preview ready.", "Review needed!", "Ready?"])(
    "preserves report punctuation in %s",
    (summary) => {
      expect(
        pendingBanner({ ...heldAction, report: { ...heldAction.report!, summary } })?.description,
      ).toContain(`Succeeded: ${summary} Automatic wake-ups`);
    },
  );

  it("uses current pause truth independently of retained intent after Resume", () => {
    expect(pendingBanner(heldAction, false)?.title).toBe("Wait for PR · Sending result");
    expect(pendingBanner({ ...heldAction, heldByEnvironmentPause: false })?.title).toBe(
      "Wait for PR · Environment paused",
    );
    expect(pendingBanner({ ...heldAction, delivery: "delivered" }, false)?.title).toBe(
      "Wait for PR · Result sent",
    );
  });
});

describe("ComposerActionResume", () => {
  it("provides compact running content for a composer banner", () => {
    const markup = renderToStaticMarkup(
      <>
        <ComposerActionResumeTitle action={action} />
        <ComposerActionResumeDescription
          action={action}
          status={actionResumeStatus({
            action,
            environmentPaused: false,
            hasPendingRequest: false,
          })}
        />
      </>,
    );

    expect(markup).toContain("Waiting");
    expect(markup).toContain("Waiting for Codex review");
    expect(markup).toContain("Watching checks and review feedback");
    expect(markup).toContain("The agent continues automatically when the command ends.");
    expect(markup).not.toContain("chat-composer-shoulder-tab");
    expect(markup).not.toContain("chat-composer-top-drawer");
  });

  it("exposes elapsed time, terminal access, and cancellation", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeActions
        action={action}
        cancelling={false}
        onCancel={() => undefined}
        onOpenTerminal={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Waiting elapsed time"');
    expect(markup).toContain('aria-label="Open Action terminal"');
    expect(markup).toContain("Cancel");
  });

  it("reports cancellation in progress and disables repeat requests", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeActions
        action={action}
        cancelling
        onCancel={() => undefined}
        onOpenTerminal={() => undefined}
      />,
    );

    expect(markup).toContain("Cancelling...");
    expect(markup).toContain("disabled");
  });

  it("falls back to the resume timing when no progress detail is available", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeDescription
        action={{ ...action, progress: undefined }}
        status={actionResumeStatus({ action, environmentPaused: false, hasPendingRequest: false })}
      />,
    );

    expect(markup).toContain("The agent continues automatically when the command ends.");
  });
});
