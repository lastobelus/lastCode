import type { ActionResumeState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerActionResumeActions,
  ComposerActionResumeDescription,
  ComposerActionResumeTitle,
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
