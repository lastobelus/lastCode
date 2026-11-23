import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { resolveSidebarFolderDot, resolveThreadStatusPill } from "../Sidebar.logic";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";
import { filterLastCodeAnnotationInboxRows } from "./lastCodeAnnotationInboxRows";

it("keeps the selected inbox row among annotation-hidden rows, including an open child's ancestor", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const open = makeThreadFixture({
    annotation: {
      body: "Wait",
      createdAt: at,
      updatedAt: at,
      resolvedAt: null,
      anchorMessageId: MessageId.make("anchor"),
      hideUntil: { kind: "date", id: CommandId.make("hide"), hiddenAt: at, at },
    },
  });
  const elsewhere = { ...open, environmentId: EnvironmentId.make("remote") };
  const visible = makeThreadFixture({ id: ThreadId.make("visible") });
  const child = makeThreadFixture({
    environmentId: open.environmentId,
    id: ThreadId.make("child"),
    lineage: {
      rootThreadId: open.id,
      parentThreadId: open.id,
      relationshipToParent: "subagent",
    },
  });
  const threads = [open, elsewhere, visible];
  const childRef = { environmentId: child.environmentId, threadId: child.id };
  const selectedAncestor = resolveListedAncestorThreadRef(childRef, [...threads, child]);

  expect(filterLastCodeAnnotationInboxRows(threads, null)).toEqual([visible]);
  expect(filterLastCodeAnnotationInboxRows(threads, lastcodeSidebarThreadKey(open))).toEqual([
    open,
    visible,
  ]);
  expect(filterLastCodeAnnotationInboxRows(threads, scopedThreadKey(selectedAncestor))).toEqual([
    open,
    visible,
  ]);
});

it("uses unread status for a reveal without a completed run until it is visited", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const thread = makeThreadFixture({
    latestRun: null,
    lastVisitedAt: null,
    annotation: {
      body: "Wait",
      createdAt: at,
      updatedAt: at,
      resolvedAt: null,
      anchorMessageId: MessageId.make("anchor"),
      reveal: {
        at,
        by: "trigger",
        trigger: { kind: "date", id: CommandId.make("hide"), hiddenAt: at, at },
      },
    },
  });
  const visited = { ...thread, lastVisitedAt: at };

  expect(resolveThreadStatusPill({ thread })?.label).toBe("Unread");
  expect(resolveSidebarFolderDot([thread])).toBe("unread");
  expect(resolveThreadStatusPill({ thread: visited })).toBeNull();
  expect(resolveSidebarFolderDot([visited])).toBeNull();
});
