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
  projectExpanded: boolean;
  descendantStatusCounts: Map<string, number>;
}

export const legacySidebarThreadKey = (thread: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function legacySidebarSubagentStatusLabel(
  thread: SidebarThreadSummary,
  status: ThreadStatusPill | null,
): string {
  if (status && status.label !== "Completed") return status.label;
  if (thread.runtime?.lastError || thread.latestRun?.status === "failed") return "Failed";
  if (thread.latestRun?.status === "interrupted" || thread.latestRun?.status === "cancelled")
    return "Stopped";
  if (thread.latestRun?.status === "completed") return "Done";
  return "Idle";
}

export function legacySidebarFamilySummary(row: LegacySidebarFamilyRow): string {
  return [
    `${row.descendantCount} ${row.descendantCount === 1 ? "subagent" : "subagents"}`,
    ...Array.from(
      row.descendantStatusCounts,
      ([label, count]) => `${count} ${label.toLowerCase()}`,
    ),
  ].join(" · ");
}

/** Projects a sorted list of visible shells. Only explicit subagent lineage creates a family.
 * Root preview limits never split a family, and a selected child always reveals its ancestors.
 * Unavailable parents and cyclic lineage leave the child reachable as an identified root.
 */
export function projectLegacySidebarFamilies(input: {
  threads: readonly SidebarThreadSummary[];
  collapsedByKey: Readonly<Record<string, boolean>>;
  activeThreadKey: string | null;
  projectExpanded: boolean;
  previewCount: number;
  listExpanded: boolean;
  statusForThread?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
}) {
  const byKey = new Map(input.threads.map((thread) => [legacySidebarThreadKey(thread), thread]));
  const parentByKey = new Map<string, string>();
  const unavailableByKey = new Map<string, string>();
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

  // A parent graph has one outgoing edge per child. Visit each edge once and detach cycles.
  const visited = new Set<string>();
  for (const key of byKey.keys()) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let cursor: string | undefined = key;
    while (cursor && !visited.has(cursor)) {
      const cycleIndex = pathIndex.get(cursor);
      if (cycleIndex !== undefined) {
        for (let index = cycleIndex; index < path.length; index++) {
          const cycleKey = path[index]!;
          const parentKey = parentByKey.get(cycleKey);
          unavailableByKey.set(
            cycleKey,
            `Parent ${byKey.get(parentKey ?? "")?.title ?? "unavailable"} · invalid lineage`,
          );
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
      projectExpanded: input.projectExpanded,
      descendantStatusCounts: new Map(),
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
    parent.descendantStatusCounts.set(label, (parent.descendantStatusCounts.get(label) ?? 0) + 1);
    for (const [descendantLabel, count] of row.descendantStatusCounts) {
      parent.descendantStatusCounts.set(
        descendantLabel,
        (parent.descendantStatusCounts.get(descendantLabel) ?? 0) + count,
      );
    }
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
