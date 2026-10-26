import type { WorktreeSuspensionSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  buildWorktreeSuspensionMenuItems,
  mergeWorktreeSuspensionMenuItems,
} from "./worktreeSuspensionMenu";

const summary: WorktreeSuspensionSummary = {
  checkoutId: "checkout",
  generation: 1,
  state: "active",
  snapshotId: null,
  lastRestoredAt: null,
  keepWorkspace: false,
};
const menu = (overrides: Partial<Parameters<typeof buildWorktreeSuspensionMenuItems>[0]> = {}) =>
  buildWorktreeSuspensionMenuItems({
    supported: true,
    hasWorktree: true,
    summary: null,
    canSuspend: true,
    canRestore: true,
    canKeep: true,
    canCreateFresh: true,
    ...overrides,
  });

it("keeps manual suspension separate from a Keep workspace hold and its release", () => {
  expect(menu().find((item) => item.id === "workspace-suspend")?.disabled).toBe(false);
  const held = menu({ summary: { ...summary, keepWorkspace: true } });
  expect(held.find((item) => item.id === "workspace-suspend")?.disabled).toBe(true);
  expect(held.find((item) => item.id === "workspace-release")?.disabled).toBe(false);
});
it("offers restore for current suspended authority and fresh creation for deliberate disposal", () => {
  const suspended = menu({ summary: { ...summary, state: "suspended", snapshotId: "copy" } });
  expect(suspended.map((item) => item.id)).toContain("workspace-restore");
  expect(suspended.map((item) => item.id)).not.toContain("workspace-suspend");
  expect(suspended.find((item) => item.id === "workspace-restore")?.disabled).toBe(false);
  expect(suspended.find((item) => item.id === "workspace-keep")?.disabled).toBe(true);
  const heldSuspended = menu({
    summary: { ...summary, state: "suspended", snapshotId: "copy", keepWorkspace: true },
  });
  expect(heldSuspended.find((item) => item.id === "workspace-release")?.disabled).toBe(true);
  const discarded = menu({ summary: { ...summary, state: "discarded" }, canCreateFresh: false });
  expect(discarded.find((item) => item.id === "workspace-create-fresh")?.disabled).toBe(true);
  expect(discarded.map((item) => item.id)).not.toContain("workspace-restore");
});
it.each(["capturing", "restoring", "discarding", "blocked"] as const)(
  "protects the checkout during %s",
  (state) => {
    expect(
      menu({ summary: { ...summary, state } })
        .filter((item) => item.id !== "workspace-status")
        .every((item) => item.disabled),
    ).toBe(true);
  },
);
it("does not expose workspace mutations on unsupported servers or project roots", () => {
  expect(menu({ supported: false })).toEqual([]);
  expect(menu({ hasWorktree: false })).toEqual([]);
});

it("puts the combined disposal choice beside archive without duplicating workspace controls", () => {
  expect(
    mergeWorktreeSuspensionMenuItems(
      [
        { id: "archive", label: "Archive" },
        { id: "delete", label: "Delete" },
      ],
      [
        { id: "workspace-restore", label: "Restore" },
        { id: "archive-discard", label: "Archive and discard" },
      ],
    ).map((item) => item.id),
  ).toEqual(["archive", "archive-discard", "delete", "workspace-restore"]);
});
it("puts disposal beside Delete when the sidebar uses a separate archive control", () => {
  expect(
    mergeWorktreeSuspensionMenuItems(
      [
        { id: "rename", label: "Rename" },
        { id: "delete", label: "Delete" },
      ],
      [{ id: "archive-discard", label: "Archive and discard" }],
    ).map((item) => item.id),
  ).toEqual(["rename", "archive-discard", "delete"]);
});
