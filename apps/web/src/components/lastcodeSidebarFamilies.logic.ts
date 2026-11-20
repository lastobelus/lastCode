import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getInteractiveThreadParentThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import type { SidebarThreadSummary } from "../types";
import {
  isSidebarSubagentThread,
  resolveProjectStatusIndicator,
  type ThreadStatusPill,
} from "./Sidebar.logic";

export interface LastCodeSidebarFamilyRow {
  thread: SidebarThreadSummary;
  key: string;
  depth: number;
  parentKey: string | null;
  unavailableParentLabel: string | null;
  descendantCount: number;
  descendantsStatus: ThreadStatusPill | null;
  expanded: boolean;
  selectedDescendant: boolean;
  collapseNavigatesToParent: boolean;
  descendantStatusCounts: Map<string, number>;
  createdThreadStatusCounts: Map<string, number>;
  creatorGroupingWarning: string | null;
  groupHeading: "Grouped under this thread" | null;
  projectExpanded: boolean;
}

export type LastCodeSidebarFamilyItem =
  | { type: "thread"; row: LastCodeSidebarFamilyRow }
  | LastCodeSidebarOwnerGroup
  | {
      type: "subagents";
      key: string;
      parentKey: string;
      parentTitle: string;
      depth: number;
      expanded: boolean;
      selectedDescendant: boolean;
      collapseNavigatesToParent: boolean;
      count: number;
      status: ThreadStatusPill | null;
    };

export interface LastCodeSidebarOwnerGroup {
  type: "owner";
  key: string;
  title: string;
  ownerRef: ScopedThreadRef | null;
  unavailable: boolean;
  count: number;
  expanded: boolean;
  status: ThreadStatusPill | null;
}

export interface LastCodeSidebarOwnership {
  projectKey: string;
  byThreadKey: ReadonlyMap<string, SidebarThreadSummary>;
  hiddenThreadKeys?: ReadonlySet<string>;
}

export function lastcodeSidebarOwnerRef(thread: SidebarThreadSummary) {
  return getThreadOwner(
    {
      creatorOrigin: thread.creatorOrigin,
      delegatedFrom: thread.delegatedFrom ?? undefined,
      lineage: thread.lineage,
    },
    thread.environmentId,
  );
}

export function lastcodeSidebarOwnerGroupKey(projectKey: string, owner: ScopedThreadRef) {
  return JSON.stringify([projectKey, owner.environmentId, owner.threadId]);
}

export const lastcodeSidebarSubagentGroupKey = (parentKey: string) => `${parentKey}:subagents`;

export const lastcodeSidebarThreadKey = (thread: SidebarThreadSummary) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const RUN_STATUS_LABELS = new Map<string, string>([
  ["failed", msg("Failed")],
  ["interrupted", msg("Stopped")],
  ["cancelled", msg("Stopped")],
  ["rolled_back", msg("Stopped")],
  ["completed", msg("Done")],
]);

export function lastcodeSidebarSubagentStatusLabel(
  thread: SidebarThreadSummary,
  status: ThreadStatusPill | null,
): string {
  if (status && status.label !== "Completed") return status.label;
  if (thread.runtime?.lastError) return msg("Failed");
  return RUN_STATUS_LABELS.get(thread.latestRun?.status ?? "") ?? msg("Idle");
}

// The parent agent decides whether a failed subagent needs human attention.
export function lastcodeSidebarInheritedStatus(
  thread: SidebarThreadSummary,
  status: ThreadStatusPill | null,
): ThreadStatusPill | null {
  return isSidebarSubagentThread(thread) && status?.label === "Failed" ? null : status;
}

export function lastcodeSidebarIsAgentCreated(thread: SidebarThreadSummary): boolean {
  return thread.source.createdBy === "agent" && thread.lineage.relationshipToParent === null;
}

export function lastcodeSidebarCreatorGroupingEligible(thread: SidebarThreadSummary): boolean {
  return lastcodeSidebarIsAgentCreated(thread) && thread.creatorThreadId !== undefined;
}

export function lastcodeSidebarThreadParentId(thread: SidebarThreadSummary) {
  return getInteractiveThreadParentThreadId({
    ...thread,
    createdBy: thread.source.createdBy,
    creationSource: thread.source.creationSource,
  });
}

export function lastcodeSidebarCreatorRef(thread: SidebarThreadSummary): ScopedThreadRef | null {
  return (
    thread.creatorOrigin ??
    thread.delegatedFrom ??
    (thread.creatorThreadId ? scopeThreadRef(thread.environmentId, thread.creatorThreadId) : null)
  );
}

function matchesRef(thread: SidebarThreadSummary | null, ref: ScopedThreadRef | null) {
  return (
    thread !== null &&
    ref !== null &&
    thread.id === ref.threadId &&
    thread.environmentId === ref.environmentId
  );
}

/** Attribution can use recovered provenance. The grouping command still uses the legacy local creator. */
export function lastcodeSidebarCreatorDetails(
  thread: SidebarThreadSummary,
  creator: SidebarThreadSummary | null,
  resolve: MessageResolver = m,
  groupingCreator = creator,
) {
  const ref = lastcodeSidebarCreatorRef(thread);
  const knownCreator = matchesRef(creator, ref) ? creator : null;
  const availableCreator = knownCreator && threadShellIsVisible(knownCreator) ? knownCreator : null;
  const localRef = thread.creatorThreadId
    ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
    : null;
  const knownGroupingCreator = matchesRef(groupingCreator, localRef) ? groupingCreator : null;
  const eligible = lastcodeSidebarCreatorGroupingEligible(thread);
  const title =
    availableCreator?.title ??
    (thread.delegatedFrom?.environmentId === ref?.environmentId &&
    thread.delegatedFrom?.threadId === ref?.threadId
      ? thread.delegatedFrom?.title
      : undefined);
  const unavailableLabel =
    ref && !title ? resolve(msg("Creator unavailable ({id})", { id: ref.threadId })) : null;
  return {
    description: title
      ? resolve(msg("Creator: {title}", { title }))
      : (unavailableLabel ??
        (lastcodeSidebarIsAgentCreated(thread) ? resolve(msg("Creator unknown")) : null)),
    unavailableLabel: thread.creatorGrouping === "grouped" ? unavailableLabel : null,
    groupingEligible:
      eligible && (!knownGroupingCreator || knownGroupingCreator.projectId === thread.projectId),
    canOpen: availableCreator !== null,
  };
}

export function lastcodeSidebarFamilySummary(
  row: LastCodeSidebarFamilyRow,
  resolve: MessageResolver = m,
): string {
  const summarize = (counts: ReadonlyMap<string, number>, kind: "subagent" | "grouped-thread") => {
    const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    if (!total) return null;
    const statuses = Array.from(counts, ([label, count]) =>
      resolve(msg("{count} {status}", { count, status: resolve(label).toLowerCase() })),
    ).join(", ");
    return kind === "subagent"
      ? resolve(
          msg("{total, plural, one {{total} subagent} other {{total} subagents}} ({statuses})", {
            total,
            statuses,
          }),
        )
      : resolve(
          msg(
            "{total, plural, one {{total} grouped thread} other {{total} grouped threads}} ({statuses})",
            { total, statuses },
          ),
        );
  };
  return [
    summarize(row.descendantStatusCounts, "subagent"),
    summarize(row.createdThreadStatusCounts, "grouped-thread"),
  ]
    .filter(Boolean)
    .join(" · ");
}

interface FamilyGraph {
  byKey: Map<string, SidebarThreadSummary>;
  parentByKey: Map<string, string>;
  unavailableByKey: Map<string, string>;
  creatorGroupingWarningByKey: Map<string, string>;
  creatorEdges: Set<string>;
}

function sameProject(thread: SidebarThreadSummary, parent: SidebarThreadSummary | undefined) {
  return parent !== undefined && parent.projectId === thread.projectId;
}

function connectSubagentParents(graph: FamilyGraph) {
  const { byKey, parentByKey, unavailableByKey } = graph;
  for (const [key, thread] of byKey) {
    if (!isSidebarSubagentThread(thread)) continue;
    const parentId = thread.lineage.parentThreadId;
    const parentKey = parentId
      ? scopedThreadKey(scopeThreadRef(thread.environmentId, parentId))
      : null;
    const parent = parentKey ? byKey.get(parentKey) : undefined;
    if (parentKey && sameProject(thread, parent)) {
      parentByKey.set(key, parentKey);
    } else {
      unavailableByKey.set(
        key,
        parentId ? `Parent unavailable (${parentId})` : "Parent unavailable",
      );
    }
  }
}

function connectCreators(graph: FamilyGraph, ownership: LastCodeSidebarOwnership | undefined) {
  const { byKey, parentByKey, creatorEdges, unavailableByKey } = graph;
  for (const [key, thread] of byKey) {
    const creatorId =
      (ownership && thread.groupedUnderThreadId) || lastcodeSidebarThreadParentId(thread);
    if (creatorId === null) continue;
    const creatorKey = scopedThreadKey(scopeThreadRef(thread.environmentId, creatorId));
    const creator = byKey.get(creatorKey);
    if (creator && creator.projectId === thread.projectId) {
      parentByKey.set(key, creatorKey);
      creatorEdges.add(key);
    } else if (thread.groupedUnderThreadId != null) {
      unavailableByKey.set(key, `Parent unavailable (${creatorId})`);
    }
  }
}

type OwnerGroup = Pick<LastCodeSidebarOwnerGroup, "title" | "ownerRef" | "unavailable">;

function connectOwners(graph: FamilyGraph) {
  const owners = new Map<string, ScopedThreadRef>();
  for (const [key, thread] of graph.byKey) {
    const owner = lastcodeSidebarOwnerRef(thread);
    if (owner === null) continue;
    owners.set(key, owner);
    if (thread.groupedUnderThreadId != null && graph.parentByKey.has(key)) continue;
    graph.parentByKey.delete(key);
    graph.creatorEdges.delete(key);
    const ownerKey = scopedThreadKey(owner);
    const ownerShell = graph.byKey.get(ownerKey);
    if (ownerShell && ownerShell.deletedAt === null && threadShellIsVisible(ownerShell)) {
      graph.parentByKey.set(key, ownerKey);
      graph.unavailableByKey.delete(key);
    }
  }
  return owners;
}

function groupUnattachedOwnedThreads(
  graph: FamilyGraph,
  ownership: LastCodeSidebarOwnership,
  owners: ReadonlyMap<string, ScopedThreadRef>,
) {
  const groups = new Map<string, OwnerGroup>();
  for (const [key, owner] of owners) {
    if (graph.parentByKey.has(key)) continue;
    const ownerKey = scopedThreadKey(owner);
    const groupKey = lastcodeSidebarOwnerGroupKey(ownership.projectKey, owner);
    graph.parentByKey.set(key, groupKey);
    const shell = graph.byKey.get(ownerKey) ?? ownership.byThreadKey.get(ownerKey);
    const available =
      shell !== undefined &&
      shell.deletedAt == null &&
      threadShellIsVisible(shell) &&
      shell.lineage.sideChat !== true &&
      !ownership.hiddenThreadKeys?.has(ownerKey);
    const thread = graph.byKey.get(key)!;
    const storedTitle = thread.delegatedFrom?.title;
    const existing = groups.get(groupKey);
    if (!existing || (existing.title === owner.threadId && storedTitle)) {
      groups.set(groupKey, {
        title: shell?.title || storedTitle || owner.threadId,
        ownerRef: available ? owner : null,
        // When a known owner is in this project, cycle repair detached the edge.
        unavailable: !available || graph.byKey.has(ownerKey),
      });
    }
  }
  return groups;
}

function detachFamilyCycle(cycleKeys: readonly string[], graph: FamilyGraph) {
  const { byKey, parentByKey, creatorEdges, creatorGroupingWarningByKey, unavailableByKey } = graph;
  // Display-only creator edges yield to delegated ownership when a mixed cycle forms.
  const creatorCycleKeys = cycleKeys.filter((cycleKey) => creatorEdges.has(cycleKey));
  for (const cycleKey of creatorCycleKeys.length ? creatorCycleKeys : cycleKeys) {
    // Every cycle edge was connected to a known thread; deleting other child edges
    // cannot remove that parent's shell from this graph.
    const parentTitle = byKey.get(parentByKey.get(cycleKey)!)!.title;
    if (creatorEdges.has(cycleKey)) {
      creatorGroupingWarningByKey.set(cycleKey, `Creator ${parentTitle} · invalid grouping`);
    } else {
      unavailableByKey.set(cycleKey, `Parent ${parentTitle} · invalid lineage`);
    }
    parentByKey.delete(cycleKey);
  }
}

function detachFamilyCycles(graph: FamilyGraph) {
  const { byKey, parentByKey } = graph;
  // A parent graph has one outgoing edge per child. Visit each edge once and detach cycles.
  const visited = new Set<string>();
  for (const key of byKey.keys()) {
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let cursor: string | undefined = key;
    while (cursor && !visited.has(cursor)) {
      const cycleIndex = pathIndex.get(cursor);
      if (cycleIndex !== undefined) {
        detachFamilyCycle(path.slice(cycleIndex), graph);
        break;
      }
      pathIndex.set(cursor, path.length);
      path.push(cursor);
      cursor = parentByKey.get(cursor);
    }
    for (const pathKey of path) visited.add(pathKey);
  }
}

function orderFamilyChildren(graph: FamilyGraph, ownerGroups: ReadonlyMap<string, OwnerGroup>) {
  const { byKey, parentByKey } = graph;
  const childrenByKey = new Map<string, string[]>();
  const roots: string[] = [];
  for (const key of byKey.keys()) {
    const parentKey = parentByKey.get(key);
    if (!parentKey) roots.push(key);
    else {
      const current = childrenByKey.get(parentKey);
      if (!current && ownerGroups.has(parentKey)) roots.push(parentKey);
      const siblings = current ?? [];
      siblings.push(key);
      childrenByKey.set(parentKey, siblings);
    }
  }
  // Keep delegated work together after ordinary conversations in both layouts.
  for (const [key, children] of childrenByKey) {
    if (ownerGroups.has(key)) continue;
    childrenByKey.set(key, [
      ...children.filter((childKey) => !isSidebarSubagentThread(byKey.get(childKey)!)),
      ...children.filter((childKey) => isSidebarSubagentThread(byKey.get(childKey)!)),
    ]);
  }
  return { childrenByKey, roots };
}

function buildFamilyGraph(
  threads: readonly SidebarThreadSummary[],
  ownership?: LastCodeSidebarOwnership,
) {
  const byKey = new Map(threads.map((thread) => [lastcodeSidebarThreadKey(thread), thread]));
  const parentByKey = new Map<string, string>();
  const unavailableByKey = new Map<string, string>();
  const creatorGroupingWarningByKey = new Map<string, string>();
  const creatorEdges = new Set<string>();
  const graph = { byKey, parentByKey, unavailableByKey, creatorGroupingWarningByKey, creatorEdges };
  if (!ownership) connectSubagentParents(graph);
  connectCreators(graph, ownership);
  const owners = ownership ? connectOwners(graph) : null;
  detachFamilyCycles(graph);
  const ownerGroups =
    ownership && owners
      ? groupUnattachedOwnedThreads(graph, ownership, owners)
      : new Map<string, OwnerGroup>();
  return { ...graph, ownerGroups, ...orderFamilyChildren(graph, ownerGroups) };
}

export function lastcodeSidebarThreadPath(
  threads: readonly SidebarThreadSummary[],
  senderRef: ScopedThreadRef,
): readonly SidebarThreadSummary[] {
  const { byKey, parentByKey } = buildFamilyGraph(threads);
  const path: SidebarThreadSummary[] = [];
  let cursor: string | undefined = scopedThreadKey(senderRef);
  while (cursor !== undefined) {
    const thread = byKey.get(cursor);
    if (thread === undefined) break;
    path.push(thread);
    cursor = parentByKey.get(cursor);
  }
  return path.toReversed();
}

type FamilyProjectionInput = {
  threads: readonly SidebarThreadSummary[];
  collapsedByKey: Readonly<Record<string, boolean>>;
  activeThreadKey: string | null;
  projectExpanded: boolean;
  previewCount: number;
  listExpanded: boolean;
  ownership?: LastCodeSidebarOwnership | undefined;
  groupingStyle?: "minimal" | "typed-groups";
  showFamilyStatusSubheaders?: boolean;
  statusForThread?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
};

type OrderedFamilyGraph = ReturnType<typeof buildFamilyGraph>;
type FamilySelection = ReturnType<typeof selectFamilyPath>;
type FamilyStatusMap = Map<string, ThreadStatusPill | null>;

function selectFamilyPath(graph: OrderedFamilyGraph, activeThreadKey: string | null) {
  const { byKey, parentByKey, ownerGroups } = graph;
  const selectedPath = new Set<string>();
  let selectedRoot: string | null = null;
  let cursor = activeThreadKey;
  while (cursor && (byKey.has(cursor) || ownerGroups.has(cursor))) {
    selectedPath.add(cursor);
    selectedRoot = cursor;
    cursor = parentByKey.get(cursor) ?? null;
  }
  const activeThread = activeThreadKey ? byKey.get(activeThreadKey) : undefined;
  const activeThreadIsSubagent =
    activeThread !== undefined && isSidebarSubagentThread(activeThread);

  return { selectedPath, selectedRoot, activeThreadIsSubagent };
}

function familyExpanded(
  collapsedByKey: FamilyProjectionInput["collapsedByKey"],
  key: string,
  selectedDescendant: boolean,
) {
  return collapsedByKey[key] === false || (collapsedByKey[key] !== true && selectedDescendant);
}

function buildFamilyRows(
  graph: OrderedFamilyGraph,
  selection: FamilySelection,
  input: FamilyProjectionInput,
) {
  const {
    byKey,
    parentByKey,
    unavailableByKey,
    creatorGroupingWarningByKey,
    childrenByKey,
    roots,
  } = graph;
  const { selectedPath, activeThreadIsSubagent } = selection;
  const allRows: LastCodeSidebarFamilyRow[] = [];
  const stack = roots.toReversed().map((key) => ({ key, depth: 0 }));
  while (stack.length) {
    const { key, depth } = stack.pop()!;
    const children = childrenByKey.get(key) ?? [];
    if (graph.ownerGroups.has(key)) {
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({ key: children[index]!, depth: depth + 1 });
      continue;
    }
    const selectedDescendant = selectedPath.has(key) && key !== input.activeThreadKey;
    allRows.push({
      thread: byKey.get(key)!,
      key,
      depth,
      parentKey: parentByKey.get(key) ?? null,
      unavailableParentLabel: unavailableByKey.get(key) ?? null,
      descendantCount: 0,
      descendantsStatus: null,
      expanded: familyExpanded(input.collapsedByKey, key, selectedDescendant),
      selectedDescendant,
      collapseNavigatesToParent: selectedDescendant && activeThreadIsSubagent,
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
  return allRows;
}

function familyStatuses(
  allRows: readonly LastCodeSidebarFamilyRow[],
  input: FamilyProjectionInput,
): FamilyStatusMap {
  return new Map(
    allRows.map((row) => {
      const status = input.statusForThread?.(row.thread) ?? null;
      const failed = lastcodeSidebarSubagentStatusLabel(row.thread, status) === "Failed";
      return [
        row.key,
        failed
          ? {
              label: msg("Failed"),
              colorClass: "text-red-700 dark:text-red-300",
              dotClass: "bg-red-600 dark:bg-red-300",
              pulse: false,
            }
          : status,
      ];
    }),
  );
}

function mergeStatusCounts(target: Map<string, number>, source: ReadonlyMap<string, number>) {
  for (const [label, count] of source) target.set(label, (target.get(label) ?? 0) + count);
}

function aggregateFamilyRows(
  allRows: readonly LastCodeSidebarFamilyRow[],
  rowByKey: Map<string, LastCodeSidebarFamilyRow>,
  statusByKey: FamilyStatusMap,
) {
  for (let index = allRows.length - 1; index >= 0; index--) {
    const row = allRows[index]!;
    const parent = row.parentKey ? rowByKey.get(row.parentKey) : undefined;
    if (!parent) continue;
    parent.descendantCount += row.descendantCount + 1;
    const rowStatus = statusByKey.get(row.key) ?? null;
    const label = lastcodeSidebarSubagentStatusLabel(row.thread, rowStatus);
    const ownCounts = isSidebarSubagentThread(row.thread)
      ? parent.descendantStatusCounts
      : parent.createdThreadStatusCounts;
    ownCounts.set(label, (ownCounts.get(label) ?? 0) + 1);
    mergeStatusCounts(parent.descendantStatusCounts, row.descendantStatusCounts);
    mergeStatusCounts(parent.createdThreadStatusCounts, row.createdThreadStatusCounts);
    parent.descendantsStatus = resolveProjectStatusIndicator([
      parent.descendantsStatus,
      row.descendantsStatus,
      lastcodeSidebarInheritedStatus(row.thread, rowStatus),
    ]);
  }
}

interface FamilyRowIndex {
  byKey: Map<string, LastCodeSidebarFamilyRow>;
  statusByKey: FamilyStatusMap;
}
function familyVisibility(
  graph: OrderedFamilyGraph,
  selection: FamilySelection,
  input: FamilyProjectionInput,
) {
  const previewRoots = input.listExpanded ? graph.roots : graph.roots.slice(0, input.previewCount);
  const renderedRootKeys = new Set(input.projectExpanded ? previewRoots : []);
  if (selection.selectedRoot) renderedRootKeys.add(selection.selectedRoot);
  return {
    ...selection,
    collapsedByKey: input.collapsedByKey,
    projectExpanded: input.projectExpanded,
    renderedRootKeys,
    showFamilyStatusSubheaders: input.showFamilyStatusSubheaders !== false,
  };
}
type FamilyVisibility = ReturnType<typeof familyVisibility>;
type VisibilityCursor = { rootIsRendered: boolean; collapsedDepth: number | null };
type SubagentGroup = Extract<LastCodeSidebarFamilyItem, { type: "subagents" }>;

function familyRowVisibility(
  row: LastCodeSidebarFamilyRow,
  cursor: VisibilityCursor,
  visibility: FamilyVisibility,
) {
  const { renderedRootKeys, selectedPath, projectExpanded } = visibility;
  if (row.depth === 0) {
    cursor.rootIsRendered = renderedRootKeys.has(row.key);
    cursor.collapsedDepth = null;
  }
  if (!cursor.rootIsRendered) {
    return "hidden";
  }
  if (!projectExpanded && !selectedPath.has(row.key)) return "skip";
  if (cursor.collapsedDepth !== null) {
    if (row.depth <= cursor.collapsedDepth) cursor.collapsedDepth = null;
    else if (!selectedPath.has(row.key)) return "skip";
  }
  return "render";
}

function buildSubagentGroup(
  row: LastCodeSidebarFamilyRow,
  graph: OrderedFamilyGraph,
  index: FamilyRowIndex,
  visibility: FamilyVisibility,
): SubagentGroup {
  const { parentKey, depth } = row as LastCodeSidebarFamilyRow & { parentKey: string };
  const { childrenByKey, byKey } = graph;
  const { selectedPath, activeThreadIsSubagent, collapsedByKey } = visibility;
  const { byKey: rowByKey, statusByKey } = index;
  const groupKey = lastcodeSidebarSubagentGroupKey(parentKey);
  const subagents = (childrenByKey.get(parentKey) ?? []).filter((key) =>
    isSidebarSubagentThread(byKey.get(key)!),
  );
  const selectedDescendant = subagents.some((key) => selectedPath.has(key));
  return {
    type: "subagents",
    key: groupKey,
    parentKey: parentKey,
    parentTitle: byKey.get(parentKey)!.title,
    depth,
    expanded: familyExpanded(collapsedByKey, groupKey, selectedDescendant),
    selectedDescendant,
    collapseNavigatesToParent: selectedDescendant && activeThreadIsSubagent,
    count: subagents.length,
    status: resolveProjectStatusIndicator(
      subagents.flatMap((key) => [
        statusByKey.get(key) ?? null,
        rowByKey.get(key)!.descendantsStatus,
      ]),
    ),
  };
}

function subagentGroupsForRows(
  graph: OrderedFamilyGraph,
  index: FamilyRowIndex,
  visibility: FamilyVisibility,
) {
  const groups = new Map<string, SubagentGroup>();
  return (row: LastCodeSidebarFamilyRow) => {
    if (
      !row.parentKey ||
      graph.ownerGroups.has(row.parentKey) ||
      !isSidebarSubagentThread(row.thread)
    )
      return null;
    let group = groups.get(row.parentKey);
    if (!group) {
      group = buildSubagentGroup(row, graph, index, visibility);
      groups.set(row.parentKey, group);
    }
    return group;
  };
}

function subagentRowVisible(
  row: LastCodeSidebarFamilyRow,
  group: SubagentGroup | null,
  cursor: VisibilityCursor,
  selectedPath: ReadonlySet<string>,
) {
  if (!group || group.expanded) return true;
  cursor.collapsedDepth ??= row.depth - 1;
  return selectedPath.has(row.key);
}

function buildOwnerGroup(
  key: string,
  owner: OwnerGroup,
  graph: OrderedFamilyGraph,
  index: FamilyRowIndex,
  visibility: FamilyVisibility,
): LastCodeSidebarOwnerGroup {
  const children = graph.childrenByKey.get(key) ?? [];
  const preference = visibility.collapsedByKey[key];
  return {
    ...owner,
    type: "owner",
    key,
    count: children.length,
    expanded:
      preference === undefined
        ? owner.unavailable || visibility.selectedPath.has(key)
        : !preference,
    status: resolveProjectStatusIndicator(
      children.flatMap((childKey) => {
        const row = index.byKey.get(childKey)!;
        return [
          lastcodeSidebarInheritedStatus(row.thread, index.statusByKey.get(childKey) ?? null),
          row.descendantsStatus,
        ];
      }),
    ),
  };
}

function renderFamilyRows(
  allRows: readonly LastCodeSidebarFamilyRow[],
  graph: OrderedFamilyGraph,
  index: FamilyRowIndex,
  visibility: FamilyVisibility,
) {
  const getGroup = subagentGroupsForRows(graph, index, visibility);
  const shownGroups = new Set<SubagentGroup>();
  const renderedRows: LastCodeSidebarFamilyRow[] = [];
  const renderedItems: LastCodeSidebarFamilyItem[] = [];
  const hiddenThreads: SidebarThreadSummary[] = [];
  const cursor = { rootIsRendered: false, collapsedDepth: null as number | null };
  let previousOwnerGroup: string | null = null;
  let ownerGroup: LastCodeSidebarOwnerGroup | null = null;
  for (const row of allRows) {
    if (row.depth === 0) ownerGroup = null;
    const owner = row.parentKey ? graph.ownerGroups.get(row.parentKey) : undefined;
    if (owner && row.parentKey !== null && previousOwnerGroup !== row.parentKey) {
      const key: string = row.parentKey;
      previousOwnerGroup = key;
      cursor.rootIsRendered = visibility.renderedRootKeys.has(key);
      cursor.collapsedDepth = null;
      ownerGroup = cursor.rootIsRendered
        ? buildOwnerGroup(key, owner, graph, index, visibility)
        : null;
      if (ownerGroup) renderedItems.push(ownerGroup);
    }
    if (owner) cursor.collapsedDepth = null;
    if (
      ownerGroup &&
      !ownerGroup.expanded &&
      !visibility.selectedPath.has(row.key) &&
      row.depth > 0
    )
      continue;
    const disposition = familyRowVisibility(row, cursor, visibility);
    if (disposition === "hidden") hiddenThreads.push(row.thread);
    if (disposition !== "render") continue;
    const group = visibility.showFamilyStatusSubheaders ? getGroup(row) : null;
    if (group && !shownGroups.has(group)) {
      renderedItems.push(group);
      shownGroups.add(group);
    }
    if (!subagentRowVisible(row, group, cursor, visibility.selectedPath)) continue;
    renderedRows.push(row);
    renderedItems.push({ type: "thread", row });
    if (!row.expanded) cursor.collapsedDepth ??= row.depth;
  }
  return { renderedRows, renderedItems, hiddenThreads };
}

function applyCreatorHeadings(
  renderedRows: readonly LastCodeSidebarFamilyRow[],
  graph: OrderedFamilyGraph,
) {
  const shownGroups = new Set<string>();
  for (const row of renderedRows) {
    if (
      !row.parentKey ||
      graph.ownerGroups.has(row.parentKey) ||
      isSidebarSubagentThread(row.thread)
    )
      continue;
    const heading = "Grouped under this thread";
    const groupKey = `${row.parentKey}:${heading}`;
    if (!shownGroups.has(groupKey)) {
      row.groupHeading = heading;
      shownGroups.add(groupKey);
    }
  }
}

/** Project sorted visible shells. Preview limits count families, and collapse keeps the selected path. */
export function projectLastCodeSidebarFamilies(input: FamilyProjectionInput) {
  const graph = buildFamilyGraph(
    input.threads.filter((thread) => thread.lineage.sideChat !== true),
    input.ownership,
  );
  const selection = selectFamilyPath(graph, input.activeThreadKey);
  const allRows = buildFamilyRows(graph, selection, input);
  const rowByKey = new Map(allRows.map((row) => [row.key, row]));
  const statusByKey = familyStatuses(allRows, input);
  aggregateFamilyRows(allRows, rowByKey, statusByKey);
  const index = { byKey: rowByKey, statusByKey };
  const { renderedRows, renderedItems, hiddenThreads } = renderFamilyRows(
    allRows,
    graph,
    index,
    familyVisibility(graph, selection, input),
  );
  if (input.groupingStyle === "typed-groups") applyCreatorHeadings(renderedRows, graph);
  return {
    allRows,
    renderedRows,
    renderedItems,
    hasOverflowingThreads: graph.roots.length > input.previewCount,
    hiddenThreads,
    orderedThreadKeys: renderedRows
      .filter((row) => row.thread.worktreeCleanup == null)
      .map((row) => row.key),
    showEmptyThreadState: input.projectExpanded && graph.roots.length === 0,
    shouldShowThreadPanel: input.projectExpanded || renderedItems.length > 0,
  };
}
