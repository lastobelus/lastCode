import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  createQuickMessageSender,
  quickMessageBlockReason,
} from "./ThreadQuickComposerDialog.logic";

describe("quick message delivery", () => {
  it("retries an unacknowledged send with the original command and message", async () => {
    const command = { commandId: "command-1", messageId: "message-1", text: "Continue" };
    const send = vi
      .fn()
      .mockResolvedValue({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    const sender = createQuickMessageSender(send);
    await sender.submit("environment/thread", () => command);
    expect(sender.hasUnacknowledgedMessage("environment/thread")).toBe(true);
    const replacement = vi.fn(() => ({
      commandId: "command-2",
      messageId: "message-2",
      text: "Changed",
    }));
    await sender.submit("environment/thread", replacement);
    expect(replacement).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([input]) => input)).toEqual([command, command]);
    expect(sender.hasUnacknowledgedMessage("environment/thread")).toBe(false);
    await sender.submit("environment/thread", replacement);
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("deduplicates synchronous submissions while independent targets can send", async () => {
    let finish!: (value: { _tag: string }) => void;
    const firstResult = new Promise<{ _tag: string }>((resolve) => {
      finish = resolve;
    });
    const send = vi.fn((input: string) =>
      input === "first" ? firstResult : Promise.resolve({ _tag: "Success" }),
    );
    const sender = createQuickMessageSender(send);
    const first = sender.submit("environment/thread", () => "first");
    expect(await sender.submit("environment/thread", () => "duplicate")).toBeUndefined();
    await sender.submit("other-environment/thread", () => "other");
    expect(send.mock.calls).toEqual([["first"], ["other"]]);
    finish({ _tag: "Success" });
    await first;
  });

  it("keeps the original retry identity when the transport throws", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const sender = createQuickMessageSender(send);
    await expect(sender.submit("thread", () => "original")).rejects.toThrow("Connection lost");
    await sender.submit("thread", () => "replacement");
    expect(send.mock.calls).toEqual([["original"], ["original"]]);
  });

  it("allows explicitly replacing a failed attempt while keeping the message text", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Failure" })
      .mockResolvedValueOnce({ _tag: "Success" });
    const sender = createQuickMessageSender(send);
    const original = { commandId: "rejected-command", messageId: "message-1", text: "Continue" };
    await sender.submit("thread", () => original);
    expect(sender.discardAttempt("thread")).toBe(true);
    expect(sender.hasUnacknowledgedMessage("thread")).toBe(false);
    const replacement = { ...original, commandId: "new-command", messageId: "message-2" };
    await sender.submit("thread", () => replacement);
    expect(send.mock.calls).toEqual([[original], [replacement]]);
  });

  it("does not discard a message whose acknowledgement is still pending", async () => {
    let finish!: (value: { _tag: string }) => void;
    const result = new Promise<{ _tag: string }>((resolve) => {
      finish = resolve;
    });
    const sender = createQuickMessageSender(() => result);
    const submitting = sender.submit("thread", () => "original");
    expect(sender.discardAttempt("thread")).toBe(false);
    expect(sender.hasUnacknowledgedMessage("thread")).toBe(true);
    finish({ _tag: "Failure" });
    await submitting;
    expect(sender.discardAttempt("thread")).toBe(true);
  });
});

describe("quick message eligibility", () => {
  const thread = makeThreadFixture();

  it.each(["approval", "question"] as const)(
    "confirms an accepted message after a lost acknowledgement and a later %s request",
    async (kind) => {
      const command = { commandId: "command-1", messageId: "message-1", text: "Continue" };
      const accepted = new Map<string, typeof command>();
      const send = vi.fn((input: typeof command) => {
        if (accepted.has(input.commandId)) return Promise.resolve({ _tag: "Success" });
        accepted.set(input.commandId, input);
        return Promise.resolve({ _tag: "Failure" });
      });
      const sender = createQuickMessageSender(send);
      expect(quickMessageBlockReason(thread, true)).toBeNull();
      await sender.submit("environment/thread", () => command);
      const waiting = {
        ...thread,
        hasPendingApprovals: kind === "approval",
        hasPendingUserInput: kind === "question",
      };
      expect(quickMessageBlockReason(waiting, true)).not.toBeNull();
      expect(
        quickMessageBlockReason(
          waiting,
          true,
          sender.hasUnacknowledgedMessage("environment/thread"),
        ),
      ).toBeNull();
      const replacement = vi.fn(() => ({ ...command, commandId: "command-2" }));
      await sender.submit("environment/thread", replacement);
      expect(replacement).not.toHaveBeenCalled();
      expect(send.mock.calls.map(([input]) => input)).toEqual([command, command]);
      expect(accepted.size).toBe(1);
      expect(sender.hasUnacknowledgedMessage("environment/thread")).toBe(false);
      expect(
        quickMessageBlockReason(
          waiting,
          true,
          sender.hasUnacknowledgedMessage("environment/thread"),
        ),
      ).not.toBeNull();
    },
  );

  it("allows retained command confirmation after other thread changes but requires a connection", () => {
    const providerOwned = {
      ...thread,
      source: {
        ...thread.source,
        creationSource: "provider" as const,
        lineage: { ...thread.source.lineage, relationshipToParent: "subagent" as const },
      },
    };
    for (const changed of [
      null,
      { ...thread, archivedAt: "2026-01-01" },
      { ...thread, deletedAt: "2026-01-01" },
      providerOwned,
      { ...thread, hasPendingApprovals: true },
      { ...thread, hasPendingUserInput: true },
    ]) {
      expect(quickMessageBlockReason(changed, true, true)).toBeNull();
      expect(quickMessageBlockReason(changed, true, false)).not.toBeNull();
      expect(quickMessageBlockReason(changed, false, true)).toContain("Reconnect");
    }
  });

  it("permits ordinary threads while preserving approval and question handling", () => {
    expect(quickMessageBlockReason(thread, true)).toBeNull();
    expect(quickMessageBlockReason({ ...thread, hasPendingApprovals: true }, true)).toContain(
      "approval",
    );
    expect(quickMessageBlockReason({ ...thread, hasPendingUserInput: true }, true)).toContain(
      "question",
    );
  });

  it("blocks unavailable, archived, deleted, and provider-owned conversations", () => {
    expect(quickMessageBlockReason(null, true)).not.toBeNull();
    expect(quickMessageBlockReason(thread, false)).toContain("Reconnect");
    expect(quickMessageBlockReason({ ...thread, archivedAt: "2026-01-01" }, true)).toContain(
      "archived",
    );
    expect(quickMessageBlockReason({ ...thread, deletedAt: "2026-01-01" }, true)).toContain(
      "no longer",
    );
    const subagent = {
      ...thread,
      source: {
        ...thread.source,
        creationSource: "provider" as const,
        lineage: { ...thread.source.lineage, relationshipToParent: "subagent" as const },
      },
    };
    expect(quickMessageBlockReason(subagent, true)).toContain("parent agent");
    expect(
      quickMessageBlockReason(
        { ...subagent, source: { ...subagent.source, creationSource: "mcp" } },
        true,
      ),
    ).toBeNull();
  });
});
