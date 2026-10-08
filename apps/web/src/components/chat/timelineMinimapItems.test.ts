import { describe, expect, it } from "vite-plus/test";
import { MessageId, ScheduledTaskId } from "@t3tools/contracts";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.messageId)).toEqual([
      MessageId.make("message-0"),
      MessageId.make("message-3"),
    ]);
    expect(resolveTimelineMinimapPreview(items[0]!)).toEqual({
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    expect(source[items[0]!.rowIndex]!.id).toBe(items[0]!.id);
    expect(resolveTimelineMinimapPreview(items[1]!)?.assistantText).toBe("Second answer");
    expect(items[0]?.assistantText).toBe(" Done\t now ");
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    expect(items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText)).toEqual([
      null,
      null,
    ]);
    expect(resolveTimelineMinimapPreview(null)).toBeNull();
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    expect(resolveTimelineMinimapPreview(next)).toEqual({
      ...first,
      assistantText: "First second",
    });
    expect(resolveTimelineMinimapPreview(first)?.assistantText).toBe("First");
  });

  it("uses the same complete incoming summary as the bubble without changing turn order", () => {
    const source = rows([
      ["user", '{"request":"Check the current work and continue when ready"}'],
      ["assistant", "All checks passed."],
      ["user", "My next question"],
    ]);
    const incoming = source[0];
    if (incoming?.kind !== "message") throw new Error("Missing incoming row");
    incoming.message = {
      ...incoming.message,
      createdBy: "agent",
      incomingSummary: { status: "ready", text: "Check the current work and continue when ready." },
    };
    const items = deriveTimelineMinimapItems(source);
    expect(items.map((item) => item.isIncoming)).toEqual([true, false]);
    expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBe(
      resolveIncomingMessagePreview(incoming.message).previewText,
    );
    expect(items[0]?.assistantText).toBe("All checks passed.");
    expect(items[0]?.messageId).toBe(incoming.message.id);
  });

  it("keeps pending automation on its original first line and short incoming text verbatim", () => {
    const source = rows([
      ["user", "Inspect status first.\nContinue with the permitted repairs."],
      ["user", "Already done."],
    ]);
    const pending = source[0];
    const short = source[1];
    if (pending?.kind !== "message" || short?.kind !== "message") throw new Error("Missing rows");
    pending.message = {
      ...pending.message,
      scheduledTaskId: ScheduledTaskId.make("task-example"),
      incomingSummary: { status: "pending" },
    };
    short.message = { ...short.message, createdBy: "agent" };
    const items = deriveTimelineMinimapItems(source);
    expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBe("Inspect status first.");
    expect(items[0]?.summaryPending).toBe(true);
    expect(resolveTimelineMinimapPreview(items[1]!)?.userText).toBe("Already done.");
  });

  it("keeps unattributed JSON human and uses the first line after a summary failure", () => {
    const source = rows([
      ["user", '{"request":"Human JSON"}'],
      ["user", "First line\nSecond line"],
    ]);
    const failed = source[1];
    if (failed?.kind !== "message") throw new Error("Missing failed row");
    failed.message = {
      ...failed.message,
      createdBy: "agent",
      incomingSummary: { status: "failed" },
    };
    const items = deriveTimelineMinimapItems(source);
    expect(items[0]?.isIncoming).toBe(false);
    expect(items[0]?.userText).toBe('{"request":"Human JSON"}');
    expect(resolveTimelineMinimapPreview(items[1]!)?.userText).toBe("First line");
    expect(items[1]?.summaryPending).toBe(false);
  });
});
