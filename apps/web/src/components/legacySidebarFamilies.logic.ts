import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
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
  creatorGroupingWarning: string | null;
  groupHeading: "Created by this thread" | null;
  projectExpanded: boolean;
}

export type LegacySidebarFamilyItem =
  | { type: "thread"; row: LegacySidebarFamilyRow }
  | {
      type: "subagents";
      key: string;
      parentKey: string;
      parentTitle: string;
      depth: number;
      expanded: boolean;
      selectedDescendant: boolean;
      count: number;
    };

export const legacySidebarSubagentGroupKey = (parentKey: string) => `${parentKey}:subagents`;

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

/** Resolve attribution separately from the project-local display family. */
export function legacySidebarCreatorDetails(
  thread: SidebarThreadSummary,
  creator: SidebarThreadSummary | null,
) {
  const knownCreator =
    creator !== null &&
    creator.id === thread.creatorThreadId &&
    creator.environmentId === thread.environmentId
      ? creator
      : null;
  const availableCreator = knownCreator && threadShellIsVisible(knownCreator) ? knownCreator : null;
  const isAgentCreated = legacySidebarIsAgentCreated(thread);
  const unavailableLabel =
    isAgentCreated && thread.creatorThreadId && !availableCreator
      ? `Creator unavailable (${thread.creatorThreadId})`
      : null;
  const eligible = legacySidebarCreatorGroupingEligible(thread);
  return {
    description: isAgentCreated
      ? availableCreator
        ? `Created by ${availableCreator.title}`
        : (unavailableLabel ?? "Creator unknown")
      : null,
    unavailableLabel: thread.creatorGrouping === "grouped" ? unavailableLabel : null,
    groupingEligible: eligible && (!knownCreator || knownCreator.projectId === thread.projectId),
    canOpen: eligible && availableCreator !== null,
  };
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
  const creatorGroupingWarningByKey = new Map<string, string>();
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
            creatorGroupingWarningByKey.set(
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
  const typedGroups = input.groupingStyle === "typed-groups";
  // Keep delegated work together after ordinary conversations in both layouts.
  for (const [key, children] of childrenByKey) {
    childrenByKey.set(key, [
      ...children.filter(
        (childKey) => byKey.get(childKey)!.lineage.relationshipToParent !== "subagent",
      ),
      ...children.filter(
        (childKey) => byKey.get(childKey)!.lineage.relationshipToParent === "subagent",
      ),
    ]);
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
      expanded: input.collapsedByKey[key] === false || selectedDescendant,
      selectedDescendant,
      descendantStatusCounts: new Map(),
      createdThreadStatusCounts: new Map(),
      creatorGroupingWarning: creatorGroupingWarningByKey.get(key) ?? null,
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
  const renderedItems: LegacySidebarFamilyItem[] = [];
  const subagentGroups = new Map<string, Extract<LegacySidebarFamilyItem, { type: "subagents" }>>();
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
    if (row.parentKey && row.thread.lineage.relationshipToParent === "subagent") {
      const groupKey = legacySidebarSubagentGroupKey(row.parentKey);
      let group = subagentGroups.get(groupKey);
      if (!group) {
        const subagents = (childrenByKey.get(row.parentKey) ?? []).filter(
          (key) => byKey.get(key)!.lineage.relationshipToParent === "subagent",
        );
        const selectedDescendant = subagents.some((key) => selectedPath.has(key));
        group = {
          type: "subagents",
          key: groupKey,
          parentKey: row.parentKey,
          parentTitle: byKey.get(row.parentKey)!.title,
          depth: row.depth,
          expanded: input.collapsedByKey[groupKey] === false || selectedDescendant,
          selectedDescendant,
          count: subagents.length,
        };
        renderedItems.push(group);
        subagentGroups.set(groupKey, group);
      }
      if (!group.expanded) {
        collapsedDepth = row.depth;
        continue;
      }
    }
    renderedRows.push(row);
    renderedItems.push({ type: "thread", row });
    if (!row.expanded) collapsedDepth = row.depth;
  }
  if (typedGroups) {
    const shownGroups = new Set<string>();
    for (const row of renderedRows) {
      if (!row.parentKey || row.thread.lineage.relationshipToParent === "subagent") continue;
      const heading = "Created by this thread";
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
    renderedItems,
    hasOverflowingThreads,
    hiddenThreads,
    orderedThreadKeys: renderedRows
      .filter((row) => row.thread.worktreeCleanup == null)
      .map((row) => row.key),
    showEmptyThreadState: input.projectExpanded && roots.length === 0,
    shouldShowThreadPanel: input.projectExpanded || renderedRows.length > 0,
  };
}
