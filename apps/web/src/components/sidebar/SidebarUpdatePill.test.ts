import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  keyReleaseNoteGroups,
  resolveReleaseNoteHeading,
  resolveSidebarUpdateButtonToneClassName,
  SidebarLocalBuildFailureTooltip,
  SidebarUpdateReleaseNotesContent,
} from "./SidebarUpdatePill.tsx";

describe("SidebarUpdatePill release notes", () => {
  it("prefers explicit local headings and preserves hosted fallbacks", () => {
    expect(
      resolveReleaseNoteHeading(
        {
          version: "1.2.4-nightly.2",
          heading: "LastCode changes",
          items: ["feat(lastcode): local change"],
        },
        0,
      ),
    ).toBe("LastCode changes");
    expect(resolveReleaseNoteHeading({ version: "1.2.4-nightly.2", items: [] }, 0)).toBe(
      "What's changed",
    );
    expect(resolveReleaseNoteHeading({ version: "1.2.4-nightly.1", items: [] }, 1)).toBe(
      "Changes in 1.2.4-nightly.1",
    );
  });

  it("keys LastCode and upstream groups independently at the same version", () => {
    const keyed = keyReleaseNoteGroups([
      {
        version: "1.2.4-nightly.2",
        heading: "LastCode changes",
        items: ["local"],
      },
      {
        version: "1.2.4-nightly.2",
        heading: "Upstream changes",
        items: ["upstream"],
      },
      {
        version: "1.2.4-nightly.2",
        heading: "LastCode changes",
        items: ["duplicate section fixture"],
      },
    ]);

    expect(new Set(keyed.map(({ key }) => key)).size).toBe(3);
    expect(keyed.map(({ releaseNote }) => releaseNote.heading)).toEqual([
      "LastCode changes",
      "Upstream changes",
      "LastCode changes",
    ]);
  });

  it("renders ordered sections, summaries outside bullets, separators, and scrolling", () => {
    const markup = renderToStaticMarkup(
      SidebarUpdateReleaseNotesContent({
        releaseNotes: [
          {
            version: "1.2.4-nightly.2",
            heading: "LastCode changes",
            items: ["local change"],
            summaries: ["2 more LastCode changes"],
          },
          {
            version: "1.2.4-nightly.2",
            heading: "Upstream changes",
            items: ["upstream change"],
          },
        ],
      }),
    );

    expect(markup.indexOf("LastCode changes")).toBeLessThan(markup.indexOf("Upstream changes"));
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("my-3 bg-border/60");
    expect(markup).toContain('<li class="list-disc break-words">local change</li>');
    expect(markup).toContain('<p class="break-words">2 more LastCode changes</p>');
    expect(markup).not.toContain('<li class="list-disc break-words">2 more LastCode changes</li>');
  });
});

describe("SidebarUpdatePill local failure", () => {
  it("uses a destructive button tone without changing the ordinary update tone", () => {
    expect(
      resolveSidebarUpdateButtonToneClassName({
        hasLocalBuildFailure: true,
        showUpdateIconState: true,
      }),
    ).toContain("bg-destructive/12");
    expect(
      resolveSidebarUpdateButtonToneClassName({
        hasLocalBuildFailure: false,
        showUpdateIconState: true,
      }),
    ).toContain("bg-update-surface");
  });

  it("renders persistent failure context and an accessible copy action", () => {
    const markup = renderToStaticMarkup(
      SidebarLocalBuildFailureTooltip({
        failure: {
          checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.4",
          phase: "Building DMG",
          percent: 94,
          errorKind: "packaging",
          currentVersion: "1.2.2",
          targetVersion: "1.2.3-nightly.4",
          logPath: "/Users/test/.lastcode/local-updates/build.log",
          error: "hdiutil failed",
        },
        isCopied: false,
        onCopy: () => undefined,
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Local build failed");
    expect(markup).toContain("Building DMG · 94% est.");
    expect(markup).toContain("hdiutil failed");
    expect(markup).toContain("Copy details");
    expect(markup).toContain('aria-label="Copy local build failure details"');
    expect(markup).toContain("text-destructive-foreground");
  });
});
