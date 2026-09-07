import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadStatusLabel, ThreadWorktreeIndicator } from "./ThreadStatusIndicators";

describe("ThreadStatusLabel", () => {
  it("keeps the status dot the same size when labels are compacted", () => {
    const status = {
      colorClass: "text-sky-600",
      dotClass: "bg-sky-500",
      label: "Working",
      pulse: false,
    };

    const expandedMarkup = renderToStaticMarkup(<ThreadStatusLabel status={status} />);
    const compactMarkup = renderToStaticMarkup(<ThreadStatusLabel status={status} compact />);

    expect(expandedMarkup).toContain("size-1.5");
    expect(compactMarkup).toContain("size-1.5");
    expect(compactMarkup).not.toContain("size-[9px]");
  });
});

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
