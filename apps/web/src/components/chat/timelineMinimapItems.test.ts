import { describe, expect, it } from "vite-plus/test";
import { MessageId, ScheduledTaskId } from "@t3tools/contracts";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  timelineMinimapPreviewUsesFullText,
} from "./timelineMinimapItems";
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

  it("wraps ready summaries and short originals while raw fallback previews stay bounded", () => {
    const raw = JSON.stringify({ request: "Inspect status. ".repeat(40) });
    const source = rows([
      ["user", raw],
      ["user", raw],
      ["user", raw],
      ["user", "Done."],
      ["user", "First line\nLong original continues here."],
    ]);
    const states = [
      undefined,
      { status: "failed" as const },
      { status: "ready" as const, text: "Inspect status and continue authorized work." },
      undefined,
      { status: "pending" as const },
    ];
    for (const [index, row] of source.entries()) {
      if (row.kind !== "message") continue;
      row.message = { ...row.message, createdBy: "agent", incomingSummary: states[index] };
    }
    const items = deriveTimelineMinimapItems(source);
    expect(items.map(timelineMinimapPreviewUsesFullText)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(items.map((item) => item.isSummary)).toEqual([false, false, true, false, false]);
    expect(items[2]?.userText).toBe("Inspect status and continue authorized work.");
    expect(items[0]?.userText).toBe(raw);
  });
});
