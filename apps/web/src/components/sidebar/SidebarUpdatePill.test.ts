import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  keyReleaseNoteGroups,
  resolveReleaseNoteHeading,
  SidebarUpdateReleaseNotes,
} from "./SidebarUpdateReleaseNotes.tsx";

describe("SidebarUpdatePill release notes", () => {
  it("prefers explicit local headings and preserves hosted fallbacks", () => {
    expect(
      resolveReleaseNoteHeading(
        {
          version: "1.2.4-nightly.2",
          heading: "LastCode changes",
          items: ["feat(lastcode): local change"],
          totalItems: 1,
        },
        0,
      ),
    ).toBe("LastCode changes");
    expect(
      resolveReleaseNoteHeading({ version: "1.2.4-nightly.2", items: [], totalItems: 0 }, 0),
    ).toBe(
      "What's changed",
    );
    expect(
      resolveReleaseNoteHeading({ version: "1.2.4-nightly.1", items: [], totalItems: 0 }, 1),
    ).toBe("Changes in 1.2.4-nightly.1");
  });

  it("keys LastCode and upstream groups independently at the same version", () => {
    const keyed = keyReleaseNoteGroups([
      {
        version: "1.2.4-nightly.2",
        heading: "LastCode changes",
        items: ["local"],
        totalItems: 1,
      },
      {
        version: "1.2.4-nightly.2",
        heading: "Upstream changes",
        items: ["upstream"],
        totalItems: 1,
      },
      {
        version: "1.2.4-nightly.2",
        heading: "LastCode changes",
        items: ["duplicate section fixture"],
        totalItems: 1,
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
      createElement(SidebarUpdateReleaseNotes, {
        shell: undefined,
        tooltip: "Update available",
        state: {
          enabled: true,
          source: "lastcode-local",
          status: "available",
          channel: "nightly",
          currentVersion: "1.2.4-nightly.1",
          hostArch: "arm64",
          appArch: "arm64",
          runningUnderArm64Translation: false,
          availableVersion: "1.2.4-nightly.2",
          downloadedVersion: null,
          releaseNotes: [
            {
              version: "1.2.4-nightly.2",
              heading: "LastCode changes",
              items: ["local change"],
              totalItems: 1,
              summaries: ["2 more LastCode changes"],
            },
            {
              version: "1.2.4-nightly.2",
              heading: "Upstream changes",
              items: ["upstream change"],
              totalItems: 1,
            },
          ],
          omittedReleaseCount: 0,
          downloadPercent: null,
          checkedAt: null,
          message: null,
          errorContext: null,
          canRetry: false,
        },
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
