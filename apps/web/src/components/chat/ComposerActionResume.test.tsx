import type { ActionResumeState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerActionResumeBadge,
  ComposerActionResumeDrawer,
  type ComposerResumableAction,
} from "./ComposerActionResume";

const action: ComposerResumableAction = {
  action: {
    runId: "run-1",
    threadId: "thread-1",
    projectId: "project-1",
    actionId: "deploy-preview",
    actionName: "Deploy preview",
    terminalId: "terminal-1",
    outcome: "running",
    delivery: "armed",
    startedAt: "2026-08-25T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
  } as ActionResumeState,
  command: "vp run deploy:preview",
};

describe("ComposerActionResumeBadge", () => {
  it("renders the running Action as the composer shoulder", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeBadge action={action} expanded={false} onToggle={() => undefined} />,
    );

    expect(markup).toContain('data-composer-action-resume-badge="true"');
    expect(markup).toContain("chat-composer-shoulder-tab");
    expect(markup).toContain("lucide-rotate-ccw-clock");
    expect(markup).toContain("Deploy preview");
    expect(markup).toContain("Running");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("has a compact inline fallback when composer shoulders are occupied", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeBadge
        action={action}
        expanded={false}
        onToggle={() => undefined}
        placement="inline"
      />,
    );

    expect(markup).toContain("lucide-rotate-ccw-clock");
    expect(markup).toContain("Deploy preview");
    expect(markup).not.toContain("chat-composer-shoulder-tab");
  });
});

describe("ComposerActionResumeDrawer", () => {
  it("explains the resume behavior and exposes terminal controls", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeDrawer
        action={action}
        cancelling={false}
        onCancel={() => undefined}
        onCollapse={() => undefined}
        onOpenTerminal={() => undefined}
      />,
    );

    expect(markup).toContain('data-chat-composer-action-resume-drawer="true"');
    expect(markup).toContain('data-variant="warning"');
    expect(markup).toContain("vp run deploy:preview");
    expect(markup).toContain(
      "When it finishes, LastCode resumes the agent once this thread is idle",
    );
    expect(markup).toContain("Open terminal");
    expect(markup).toContain("Cancel Action");
  });

  it("handles Actions whose configured command is no longer available", () => {
    const markup = renderToStaticMarkup(
      <ComposerActionResumeDrawer
        action={{ ...action, command: null }}
        cancelling={false}
        onCancel={() => undefined}
        onCollapse={() => undefined}
        onOpenTerminal={() => undefined}
      />,
    );

    expect(markup).toContain("Command unavailable");
  });
});
