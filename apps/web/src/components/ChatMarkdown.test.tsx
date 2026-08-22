import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { orderedListGutterStyle, resolveChatMarkdownEnvironmentId } from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
  });
});

describe("resolveChatMarkdownEnvironmentId", () => {
  it("uses the supplied thread environment for cross-environment markdown actions", () => {
    const activeEnvironmentId = EnvironmentId.make("environment-a");
    const threadEnvironmentId = EnvironmentId.make("environment-b");

    expect(
      resolveChatMarkdownEnvironmentId(activeEnvironmentId, {
        environmentId: threadEnvironmentId,
        threadId: ThreadId.make("thread-b"),
      }),
    ).toBe(threadEnvironmentId);
  });

  it("falls back to the active environment without a thread reference", () => {
    const activeEnvironmentId = EnvironmentId.make("environment-a");

    expect(resolveChatMarkdownEnvironmentId(activeEnvironmentId, undefined)).toBe(
      activeEnvironmentId,
    );
  });
});
