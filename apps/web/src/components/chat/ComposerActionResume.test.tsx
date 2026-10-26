import type { ActionResumeState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerActionResumeActions,
  ComposerActionResumeDescription,
  ComposerActionResumeTitle,
  heldActionBanner,
} from "./ComposerActionResume";

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

describe("completed Action held by environment Pause", () => {
  it("selects a completed pending result and retains its summary without delivery controls", () => {
    const banner = heldActionBanner(heldAction);
    expect(banner).toMatchObject({
      id: "action-held:run-1",
      title: "Succeeded: Wait for PR",
      description:
        "Documentation preview ready. The agent hasn't picked up this result. If this environment is paused, resume it in Settings → Connections to let the agent follow up.",
    });
    expect(banner?.actions).toBeUndefined();
    expect(banner?.onDismiss).toBeUndefined();
    expect(heldAction.delivery).toBe("pending");
  });

  it.each([
    null,
    action,
    { ...heldAction, outcome: "running" as const },
    { ...heldAction, heldByEnvironmentPause: false },
    { ...heldAction, heldByEnvironmentPause: undefined },
    ...(["armed", "available", "delivered", "disposed"] as const).map((delivery) => ({
      ...heldAction,
      delivery,
    })),
  ])("does not relabel other lifecycle states: %j", (state) => {
    expect(heldActionBanner(state)).toBeNull();
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
      heldActionBanner({
        ...heldAction,
        outcome,
        report: { ...heldAction.report!, outcome: reportOutcome },
      })?.title,
    ).toBe(`${label}: Wait for PR`);
  });

  it("still identifies the completed result without a retained report", () => {
    const banner = heldActionBanner({ ...heldAction, report: undefined });
    expect(banner?.title).toBe("Succeeded: Wait for PR");
    expect(banner?.children).toBeUndefined();
    expect(banner?.description).toBe(
      "The agent hasn't picked up this result. If this environment is paused, resume it in Settings → Connections to let the agent follow up.",
    );
  });

  it.each(["Preview ready.", "Review needed!", "Ready?"])(
    "preserves report punctuation in %s",
    (summary) => {
      expect(
        heldActionBanner({
          ...heldAction,
          report: { ...heldAction.report!, summary },
        })?.description,
      ).toBe(
        `${summary} The agent hasn't picked up this result. If this environment is paused, resume it in Settings → Connections to let the agent follow up.`,
      );
    },
  );

  it("keeps retained pending intent after Resume without claiming the environment is still paused", () => {
    expect(heldActionBanner(heldAction)?.description).toContain("If this environment is paused");
    expect(heldActionBanner({ ...heldAction, heldByEnvironmentPause: false })).toBeNull();
    expect(heldActionBanner({ ...heldAction, delivery: "delivered" })).toBeNull();
    expect(heldActionBanner({ ...heldAction, delivery: "available" })).toBeNull();
  });
});

describe("ComposerActionResume", () => {
  it("provides compact running content for a composer banner", () => {
    const markup = renderToStaticMarkup(
      <>
        <ComposerActionResumeTitle action={action} />
        <ComposerActionResumeDescription action={action} />
      </>,
    );

    expect(markup).toContain("Waiting");
    expect(markup).toContain("Waiting for Codex review");
    expect(markup).toContain("Watching checks and review feedback");
    expect(markup).toContain("Resumes when this thread is idle.");
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
      <ComposerActionResumeDescription action={{ ...action, progress: undefined }} />,
    );

    expect(markup).toContain("Resumes when this thread is idle.");
  });
});
