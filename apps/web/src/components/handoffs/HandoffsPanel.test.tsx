import { describe, expect, it } from "vite-plus/test";

import { filterHandoffs } from "./HandoffsPanel";
import type { HandoffEntry } from "~/handoffs/handoffsStore";

const entries: HandoffEntry[] = [
  {
    id: "file:/workspace/src/App.tsx",
    target: { kind: "file", path: "/workspace/src/App.tsx" },
    lastOpenedAt: 3,
    sequence: 3,
    markdownLabel: "App shell",
  },
  {
    id: "url:https://example.com/docs",
    target: { kind: "url", url: "https://example.com/docs" },
    lastOpenedAt: 2,
    sequence: 2,
  },
];

describe("filterHandoffs", () => {
  it("matches title, destination, and URL case-insensitively", () => {
    expect(filterHandoffs(entries, "APP SHELL")).toHaveLength(1);
    expect(filterHandoffs(entries, "workspace/src/app")).toHaveLength(1);
    expect(filterHandoffs(entries, "EXAMPLE.COM/DOCS")).toHaveLength(1);
  });

  it("returns all entries for an empty query", () => {
    expect(filterHandoffs(entries, "  ")).toEqual(entries);
  });
});
