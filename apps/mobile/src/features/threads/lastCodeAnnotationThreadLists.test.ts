import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  filterLastCodeAnnotationThreadRows,
  filterLastCodeMobilePaletteThreads,
  getLastCodeAnnotationOrderedSection,
  planLastCodeAnnotationThreadMove,
} from "./lastCodeAnnotationThreadLists";
import { createPendingThreadOrder, reconcilePendingThreadOrder } from "./threadOrder";

const now = "2026-01-01T00:00:00.000Z";
const annotation: ThreadAnnotation = {
  body: "Wait",
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
  anchorMessageId: MessageId.make("anchor"),
  hideUntil: { kind: "date", id: CommandId.make("hide"), hiddenAt: now, at: now },
};
const environmentId = EnvironmentId.make("local");
const annotated = makeThreadShellFixture({
  environmentId,
  id: ThreadId.make("annotated"),
  annotation,
  title: "Pairing regression",
  branch: "next-release",
});

describe("mobile annotation navigation", () => {
  it("uses a trimmed title match at the command palette seam", () => {
    const visible = makeThreadShellFixture({ environmentId, id: ThreadId.make("visible") });
    const inherited = { ...annotated, id: ThreadId.make("inherited"), annotation: null };
    const hidden = new Set([scopedThreadKey(environmentId, inherited.id)]);
    const threads = [annotated, inherited, visible];
    expect(filterLastCodeMobilePaletteThreads(threads, "", hidden)).toEqual([visible]);
    expect(filterLastCodeMobilePaletteThreads(threads, "  ", hidden)).toEqual([visible]);
    expect(filterLastCodeMobilePaletteThreads(threads, "next-release", hidden)).toEqual([visible]);
    expect(filterLastCodeMobilePaletteThreads(threads, "  PAIRING  ", hidden)).toEqual(threads);
  });

  it("retains the open drawer row only when it belongs to that environment's input", () => {
    const key = `${annotated.environmentId}:${annotated.id}`;
    const remote = { ...annotated, environmentId: EnvironmentId.make("remote") };
    const hidden = new Set([key, scopedThreadKey(remote.environmentId, remote.id)]);
    expect(filterLastCodeAnnotationThreadRows([annotated, remote], hidden)).toEqual([]);
    expect(filterLastCodeAnnotationThreadRows([annotated, remote], hidden, key)).toEqual([
      annotated,
    ]);
    expect(filterLastCodeAnnotationThreadRows([remote], hidden, key)).toEqual([]);
  });

  it("moves among visible rows while reserving the order key of a hidden neighbor", () => {
    const hiddenKey = pinOrderKeyBetween("b", "m");
    expect(hiddenKey).not.toBeNull();
    const first = makeThreadShellFixture({
      environmentId,
      id: ThreadId.make("first"),
      pinOrderKey: "b",
      pinnedAt: now,
    });
    const hidden = { ...annotated, pinOrderKey: hiddenKey, pinnedAt: now };
    const second = { ...first, id: ThreadId.make("second"), pinOrderKey: "m" };
    const moved = { ...first, id: ThreadId.make("moved"), pinOrderKey: "z" };
    const plan = planLastCodeAnnotationThreadMove({
      threads: [first, hidden, second, moved],
      annotationHiddenThreadKeys: new Set([scopedThreadKey(hidden.environmentId, hidden.id)]),
      section: "pinned",
      now,
      movedId: "local:moved",
      direction: "up",
      reorderableEnvironmentIds: new Set([environmentId]),
    });

    expect(plan?.ordered).toEqual([first, second, moved]);
    expect(plan?.assignments).toEqual([
      { id: "local:moved", orderKey: pinOrderKeyBetween(hiddenKey, "m") },
    ]);
  });

  it("keeps the hidden parent row selected by an open child in its section during a move", () => {
    const first = makeThreadShellFixture({
      environmentId,
      id: ThreadId.make("first"),
      pinOrderKey: "b",
      pinnedAt: now,
    });
    const open = { ...annotated, pinOrderKey: "m", pinnedAt: now };
    const child = makeThreadShellFixture({
      environmentId,
      id: ThreadId.make("open-child"),
      lineage: {
        rootThreadId: open.id,
        parentThreadId: open.id,
        relationshipToParent: "subagent",
      },
    });
    const drawerThreads = [first, open];
    const row = resolveListedAncestorThreadRef({ environmentId, threadId: child.id }, [
      ...drawerThreads,
      child,
    ]);
    const retainedThreadKey = scopedThreadKey(row.environmentId, row.threadId);
    const annotationHiddenThreadKeys = new Set([retainedThreadKey]);
    expect(
      filterLastCodeAnnotationThreadRows(
        drawerThreads,
        annotationHiddenThreadKeys,
        retainedThreadKey,
      ),
    ).toEqual(drawerThreads);
    const input = {
      threads: drawerThreads,
      section: "pinned" as const,
      now,
      movedId: "local:annotated",
      retainedThreadKey,
      annotationHiddenThreadKeys,
      direction: "up" as const,
      reorderableEnvironmentIds: new Set([environmentId]),
    };
    const plan = planLastCodeAnnotationThreadMove(input);
    expect(plan).not.toBeNull();
    if (!plan) throw new Error("Expected an in-section move");
    expect(plan.crossSection).toBe(false);
    expect(plan.ordered).toEqual([first, open]);

    const pending = createPendingThreadOrder({ ...input, ...plan });
    const current = getLastCodeAnnotationOrderedSection(
      input,
      annotationHiddenThreadKeys,
      retainedThreadKey,
    );
    expect(reconcilePendingThreadOrder(pending, current)).toBe(pending);
    expect(
      reconcilePendingThreadOrder(
        pending,
        getLastCodeAnnotationOrderedSection(input, annotationHiddenThreadKeys),
      ),
    ).toBeNull();
  });
});
