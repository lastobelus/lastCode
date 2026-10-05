import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../types";
import { resolveProjectStatusIndicator, type ThreadStatusPill } from "./Sidebar.logic";

export interface LegacySidebarFamilyRow {
  thread: SidebarThreadSummary;
  key: string;
  depth: number;
  parentKey: string | null;
  unavailableParentLabel: string | null;
  descendantCount: number;
  descendantsStatus: ThreadStatusPill | null;
  expanded: boolean;
  selectedDescendant: boolean;
  descendantStatusCounts: Map<string, number>;
  createdThreadStatusCounts: Map<string, number>;
  unavailableCreatorLabel: string | null;
  groupHeading: "Subagents" | "Created by this thread" | null;
  projectExpanded: boolean;
}

export const legacySidebarThreadKey = (thread: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function legacySidebarSubagentStatusLabel(
  thread: SidebarThreadSummary,
  status: ThreadStatusPill | null,
): string {
  if (status && status.label !== "Completed") return status.label;
  if (thread.runtime?.lastError || thread.latestRun?.status === "failed") return "Failed";
  if (
    thread.latestRun?.status === "interrupted" ||
    thread.latestRun?.status === "cancelled" ||
    thread.latestRun?.status === "rolled_back"
  )
    return "Stopped";
  if (thread.latestRun?.status === "completed") return "Done";
  return "Idle";
}

export function legacySidebarIsAgentCreated(thread: SidebarThreadSummary): boolean {
  return thread.source.createdBy === "agent" && thread.lineage.relationshipToParent === null;
}

export function legacySidebarCreatorGroupingEligible(thread: SidebarThreadSummary): boolean {
  return legacySidebarIsAgentCreated(thread) && thread.creatorThreadId !== undefined;
}

export function legacySidebarFamilySummary(row: LegacySidebarFamilyRow): string {
  const summarize = (counts: ReadonlyMap<string, number>, singular: string, plural: string) => {
    const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    if (!total) return null;
    return `${total} ${total === 1 ? singular : plural} (${Array.from(counts, ([label, count]) => `${count} ${label.toLowerCase()}`).join(", ")})`;
  };
  return [
    summarize(row.descendantStatusCounts, "subagent", "subagents"),
    summarize(row.createdThreadStatusCounts, "created thread", "created threads"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Projects sorted visible shells into owned subagent and display-only creator families.
 * Root preview limits never split a family, and a selected child always reveals its ancestors.
 * Creator grouping only changes display placement; it never changes the conversation lineage.
 * Unavailable parents/creators and cycles leave the child reachable as an identified root.
 */
export function projectLegacySidebarFamilies(input: {
  threads: readonly SidebarThreadSummary[];
  collapsedByKey: Readonly<Record<string, boolean>>;
  activeThreadKey: string | null;
  projectExpanded: boolean;
  previewCount: number;
  listExpanded: boolean;
  groupingStyle?: "minimal" | "typed-groups";
  statusForThread?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
}) {
  const byKey = new Map(input.threads.map((thread) => [legacySidebarThreadKey(thread), thread]));
  const parentByKey = new Map<string, string>();
  const unavailableByKey = new Map<string, string>();
  const unavailableCreatorByKey = new Map<string, string>();
  const creatorEdges = new Set<string>();
  for (const [key, thread] of byKey) {
    if (thread.lineage.relationshipToParent !== "subagent") continue;
    const parentId = thread.lineage.parentThreadId;
    const parentKey = parentId
      ? scopedThreadKey(scopeThreadRef(thread.environmentId, parentId))
      : null;
    const parent = parentKey ? byKey.get(parentKey) : undefined;
    if (parentKey && parent && parent.projectId === thread.projectId) {
      parentByKey.set(key, parentKey);
    } else {
      unavailableByKey.set(
        key,
        parentId ? `Parent unavailable (${parentId})` : "Parent unavailable",
      );
    }
  }

  for (const [key, thread] of byKey) {
    if (!legacySidebarCreatorGroupingEligible(thread) || thread.creatorGrouping !== "grouped")
      continue;
    const creatorId = thread.creatorThreadId!;
    const creatorKey = scopedThreadKey(scopeThreadRef(thread.environmentId, creatorId));
    const creator = byKey.get(creatorKey);
    if (creator && creator.projectId === thread.projectId) {
      parentByKey.set(key, creatorKey);
      creatorEdges.add(key);
    } else {
      unavailableCreatorByKey.set(key, `Creator unavailable (${creatorId})`);
    }
  }

  // A parent graph has one outgoing edge per child. Visit each edge once and detach cycles.
  const visited = new Set<string>();
  for (const key of byKey.keys()) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let cursor: string | undefined = key;
    while (cursor && !visited.has(cursor)) {
      const cycleIndex = pathIndex.get(cursor);
      if (cycleIndex !== undefined) {
        const cycleKeys = path.slice(cycleIndex);
        // Display-only creator edges yield to delegated ownership when a mixed cycle forms.
        const creatorCycleKeys = cycleKeys.filter((cycleKey) => creatorEdges.has(cycleKey));
        for (const cycleKey of creatorCycleKeys.length ? creatorCycleKeys : cycleKeys) {
          const parentKey = parentByKey.get(cycleKey);
          if (creatorEdges.has(cycleKey)) {
            unavailableCreatorByKey.set(
              cycleKey,
              `Creator ${byKey.get(parentKey ?? "")?.title ?? "unavailable"} · invalid grouping`,
            );
          } else {
            unavailableByKey.set(
              cycleKey,
              `Parent ${byKey.get(parentKey ?? "")?.title ?? "unavailable"} · invalid lineage`,
            );
          }
          parentByKey.delete(cycleKey);
        }
        break;
      }
      pathIndex.set(cursor, path.length);
      path.push(cursor);
      cursor = parentByKey.get(cursor);
    }
    for (const pathKey of path) visited.add(pathKey);
  }

  const childrenByKey = new Map<string, string[]>();
  const roots: string[] = [];
  for (const key of byKey.keys()) {
    const parentKey = parentByKey.get(key);
    if (!parentKey) roots.push(key);
    else {
      const siblings = childrenByKey.get(parentKey) ?? [];
      siblings.push(key);
      childrenByKey.set(parentKey, siblings);
    }
  }
  const typedGroups = input.groupingStyle !== "minimal";
  if (typedGroups) {
    for (const [key, children] of childrenByKey) {
      childrenByKey.set(key, [
        ...children.filter(
          (childKey) => byKey.get(childKey)!.lineage.relationshipToParent === "subagent",
        ),
        ...children.filter(
          (childKey) => byKey.get(childKey)!.lineage.relationshipToParent !== "subagent",
        ),
      ]);
    }
  }
  const selectedPath = new Set<string>();
  let selectedRoot: string | null = null;
  let cursor = input.activeThreadKey;
  while (cursor && byKey.has(cursor)) {
    selectedPath.add(cursor);
    selectedRoot = cursor;
    cursor = parentByKey.get(cursor) ?? null;
  }

  const allRows: LegacySidebarFamilyRow[] = [];
  const stack = roots.toReversed().map((key) => ({ key, depth: 0 }));
  while (stack.length) {
    const { key, depth } = stack.pop()!;
    const children = childrenByKey.get(key) ?? [];
    const selectedDescendant = selectedPath.has(key) && key !== input.activeThreadKey;
    allRows.push({
      thread: byKey.get(key)!,
      key,
      depth,
      parentKey: parentByKey.get(key) ?? null,
      unavailableParentLabel: unavailableByKey.get(key) ?? null,
      descendantCount: 0,
      descendantsStatus: null,
      expanded: input.collapsedByKey[key] !== true || selectedDescendant,
      selectedDescendant,
      descendantStatusCounts: new Map(),
      createdThreadStatusCounts: new Map(),
      unavailableCreatorLabel: unavailableCreatorByKey.get(key) ?? null,
      groupHeading: null,
      projectExpanded: input.projectExpanded,
    });
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ key: children[index]!, depth: depth + 1 });
    }
  }
  const rowByKey = new Map(allRows.map((row) => [row.key, row]));
  for (let index = allRows.length - 1; index >= 0; index--) {
    const row = allRows[index]!;
    const parent = row.parentKey ? rowByKey.get(row.parentKey) : undefined;
    if (!parent) continue;
    parent.descendantCount += row.descendantCount + 1;
    const rowStatus = input.statusForThread?.(row.thread) ?? null;
    const label = legacySidebarSubagentStatusLabel(row.thread, rowStatus);
    const ownCounts =
      row.thread.lineage.relationshipToParent === "subagent"
        ? parent.descendantStatusCounts
        : parent.createdThreadStatusCounts;
    ownCounts.set(label, (ownCounts.get(label) ?? 0) + 1);
    const addCounts = (target: Map<string, number>, source: ReadonlyMap<string, number>) => {
      for (const [descendantLabel, count] of source) {
        target.set(descendantLabel, (target.get(descendantLabel) ?? 0) + count);
      }
    };
    addCounts(parent.descendantStatusCounts, row.descendantStatusCounts);
    addCounts(parent.createdThreadStatusCounts, row.createdThreadStatusCounts);
    parent.descendantsStatus = resolveProjectStatusIndicator([
      parent.descendantsStatus,
      row.descendantsStatus,
      rowStatus,
    ]);
  }

  const hasOverflowingThreads = roots.length > input.previewCount;
  const previewRoots = input.listExpanded ? roots : roots.slice(0, input.previewCount);
  const renderedRootKeys = new Set(input.projectExpanded ? previewRoots : []);
  if (selectedRoot) renderedRootKeys.add(selectedRoot);
  const renderedRows: LegacySidebarFamilyRow[] = [];
  const hiddenThreads: SidebarThreadSummary[] = [];
  let rootIsRendered = false;
  let collapsedDepth: number | null = null;
  for (const row of allRows) {
    if (row.depth === 0) {
      rootIsRendered = renderedRootKeys.has(row.key);
      collapsedDepth = null;
    }
    if (!rootIsRendered) {
      hiddenThreads.push(row.thread);
      continue;
    }
    if (!input.projectExpanded && !selectedPath.has(row.key)) continue;
    if (collapsedDepth !== null && row.depth > collapsedDepth) continue;
    collapsedDepth = null;
    renderedRows.push(row);
    if (!row.expanded) collapsedDepth = row.depth;
  }
  if (typedGroups) {
    const shownGroups = new Set<string>();
    for (const row of renderedRows) {
      if (!row.parentKey) continue;
      const heading =
        row.thread.lineage.relationshipToParent === "subagent"
          ? "Subagents"
          : "Created by this thread";
      const groupKey = `${row.parentKey}:${heading}`;
      if (!shownGroups.has(groupKey)) {
        row.groupHeading = heading;
        shownGroups.add(groupKey);
      }
    }
  }
  return {
    allRows,
    renderedRows,
    hasOverflowingThreads,
    hiddenThreads,
    orderedThreadKeys: renderedRows
      .filter((row) => row.thread.worktreeCleanup == null)
      .map((row) => row.key),
    showEmptyThreadState: input.projectExpanded && roots.length === 0,
    shouldShowThreadPanel: input.projectExpanded || renderedRows.length > 0,
  };
}
