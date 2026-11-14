import { describe, expect, it } from "vite-plus/test";
import {
  ThreadId,
  type PreviewHostingLeaseMetadata,
  type TerminalSummary,
} from "@t3tools/contracts";
import { formatPreviewExpiry, threadTerminalProcessLabels } from "./threadTerminalPresentation";

const expiresAt = new Date(2026, 9, 5, 18, 2).toISOString();
const preview: PreviewHostingLeaseMetadata = {
  leaseId: "preview-lease",
  threadId: ThreadId.make("thread-a"),
  terminalId: "preview-terminal",
  url: "http://localhost:5173/",
  handedOffAt: new Date(2026, 9, 4, 18, 2).toISOString(),
  expiresAt,
  status: "active",
};
const terminal: TerminalSummary = {
  threadId: "thread-a",
  terminalId: "preview-terminal",
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 100,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "node",
  updatedAt: preview.handedOffAt,
};

describe("thread terminal hover labels", () => {
  it("associates each process with its own preview's local expiry", () => {
    expect(
      threadTerminalProcessLabels(
        [
          terminal,
          { ...terminal, terminalId: "test-terminal", label: "vitest" },
          { ...terminal, terminalId: "idle-terminal", hasRunningSubprocess: false },
        ],
        [preview],
      ),
    ).toEqual([
      { terminalId: "preview-terminal", label: "node (preview sleeps Oct 5, 1802)" },
      { terminalId: "test-terminal", label: "vitest" },
    ]);
  });

  it("identifies a stopped preview whose recovery lifetime can still be cancelled", () => {
    expect(threadTerminalProcessLabels([], [{ ...preview, status: "sleeping" }])).toEqual([
      {
        terminalId: "preview-terminal",
        label: "localhost:5173 (preview reopens when viewed)",
      },
    ]);
  });

  it("identifies a preview that is still starting", () => {
    expect(threadTerminalProcessLabels([], [{ ...preview, status: "starting" }])).toEqual([
      {
        terminalId: "preview-terminal",
        label: "localhost:5173 (preview starting)",
      },
    ]);
  });

  it("formats midnight as 0000 and tolerates an invalid expiry", () => {
    expect(formatPreviewExpiry(new Date(2026, 9, 5, 0, 0).toISOString())).toBe("Oct 5, 0000");
    expect(formatPreviewExpiry("invalid")).toBeNull();
  });
});
