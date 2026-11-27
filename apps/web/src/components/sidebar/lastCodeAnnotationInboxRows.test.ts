import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import { expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { resolveSidebarFolderDot, resolveThreadStatusPill } from "../Sidebar.logic";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";
import { filterLastCodeAnnotationInboxRows } from "./lastCodeAnnotationInboxRows";
import { resolveSidebarRouteReveal } from "./routeReveal";

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
  const hidden = new Set([lastcodeSidebarThreadKey(open), lastcodeSidebarThreadKey(elsewhere)]);

  expect(filterLastCodeAnnotationInboxRows(threads, null, hidden)).toEqual([visible]);
  expect(
    filterLastCodeAnnotationInboxRows(threads, lastcodeSidebarThreadKey(open), hidden),
  ).toEqual([open, visible]);
  expect(
    filterLastCodeAnnotationInboxRows(threads, scopedThreadKey(selectedAncestor), hidden),
  ).toEqual([open, visible]);
});

it("widens the inbox scope when a link opens a pending child of an annotation-hidden owner", () => {
  const child = makeThreadFixture({
    environmentId: EnvironmentId.make("linked"),
    id: ThreadId.make("child"),
    projectId: ProjectId.make("child-project"),
    hasPendingUserInput: true,
  });
  const ref = { environmentId: child.environmentId, threadId: child.id };
  const routeKey = scopedThreadKey(ref);
  const resolve = (scopedProjectKeys: ReadonlySet<string>) =>
    resolveSidebarRouteReveal({
      reveal: { observedKey: null, pendingKey: null },
      routeKey,
      routeKeyInPlace: false,
      isSearching: false,
      scopedProjectKeys,
      delegatedUnderParent: new Set([threadKey(ref)]),
      annotationPendingChildThreadKeys: new Set([routeKey]),
      findThread: (key) => (key === routeKey ? child : undefined),
    });

  expect(resolve(new Set(["local:parent-project"]))).toEqual({
    pendingKey: routeKey,
    widensScope: true,
  });
  expect(resolve(new Set(["linked:child-project"]))).toEqual({
    pendingKey: routeKey,
    widensScope: false,
  });
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
