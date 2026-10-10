import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId, type OrchestrationV2SubagentPromotion } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { canPromoteSubagent, presentSubagentPromotion } from "./subagentPromotion.ts";

const promotion = (
  status: OrchestrationV2SubagentPromotion["status"],
): OrchestrationV2SubagentPromotion => ({
  createdBy: "user",
  creationSource: "web",
  requestId: CommandId.make("promotion-request"),
  targetThreadId: ThreadId.make("interactive-thread"),
  status,
  error: status === "failed" ? "Provider fork failed" : null,
  requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
});

describe("subagent promotion actions", () => {
  it("requires both native thread and subagent fork capabilities", () => {
    expect(canPromoteSubagent(null)).toBe(false);
    expect(canPromoteSubagent({ canForkThread: true, canForkFromSubagentThread: false })).toBe(
      false,
    );
    expect(canPromoteSubagent({ canForkThread: false, canForkFromSubagentThread: true })).toBe(
      false,
    );
    expect(canPromoteSubagent({ canForkThread: true, canForkFromSubagentThread: true })).toBe(true);
  });

  it("locks a pending request without inventing durable waiting or cancellation", () => {
    expect(presentSubagentPromotion(null, true)).toMatchObject({
      busy: true,
      disabled: true,
      waiting: false,
      canCancel: false,
    });
    expect(presentSubagentPromotion(null, false)).toMatchObject({
      disabled: false,
      label: "Promote to interactive thread",
    });
  });

  it("allows cancellation only before the fork begins and locks in-flight cancellation", () => {
    expect(presentSubagentPromotion(promotion("waiting"), false)).toMatchObject({
      busy: true,
      canCancel: true,
      waiting: true,
    });
    expect(presentSubagentPromotion(promotion("waiting"), true).canCancel).toBe(false);
    expect(presentSubagentPromotion(promotion("forking"), false)).toMatchObject({
      busy: true,
      canCancel: false,
      waiting: false,
    });
  });

  it("offers retry after failure and navigation only after promotion", () => {
    expect(presentSubagentPromotion(promotion("failed"), false)).toMatchObject({
      label: "Retry",
      disabled: false,
      error: "Provider fork failed",
    });
    expect(presentSubagentPromotion(promotion("failed"), true)).toMatchObject({
      label: "Promoting to interactive thread",
      disabled: true,
      busy: true,
      error: null,
    });
    expect(presentSubagentPromotion(promotion("promoted"), false)).toMatchObject({
      label: "promoted to interactive thread",
      disabled: false,
      busy: false,
      error: null,
    });
  });
});
