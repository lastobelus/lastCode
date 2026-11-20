import {
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type PeerArchiveInventory,
  type PeerArchiveInventoryInput,
  type ThreadId,
} from "@t3tools/contracts";
import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape, ProjectionStoreV2Error } from "./ProjectionStore.ts";
import { hasUnreadArchiveResponse, hasUnfinishedArchiveWork } from "./ThreadArchivePolicy.ts";

type ArchiveInventoryStore = Pick<
  ProjectionStoreV2Shape,
  "findThread" | "getThreadShell" | "getArchiveFamilyThreadIds"
>;

interface ArchiveCandidate {
  readonly record: OrchestrationV2AppThread | OrchestrationV2ThreadShell;
  readonly shell: OrchestrationV2ThreadShell | null;
}

function keepsTypedInBranch({ shell }: ArchiveCandidate) {
  return shell?.deletedAt === null && shell.latestUserAuthoredMessageAt != null;
}

function liveInventory(
  environmentId: EnvironmentId,
  request: PeerArchiveInventoryInput,
  candidates: readonly ArchiveCandidate[],
) {
  const ownerIds = new Set(request.ownerThreadIds);
  const keptOwners = new Set(request.keptOwnerThreadIds);
  const localChildren = new Map<ThreadId, ArchiveCandidate[]>();
  const pending: Array<{ candidate: ArchiveCandidate; kept: boolean }> = [];
  for (const candidate of candidates) {
    const owner = getThreadOwner(candidate.record, environmentId);
    if (owner === null) continue;
    if (owner.environmentId === environmentId) {
      const siblings = localChildren.get(owner.threadId);
      if (siblings === undefined) localChildren.set(owner.threadId, [candidate]);
      else siblings.push(candidate);
    } else if (owner.environmentId === request.ownerEnvironmentId && ownerIds.has(owner.threadId)) {
      pending.push({ candidate, kept: keptOwners.has(owner.threadId) });
    }
  }

  const visited = new Set<ThreadId>();
  const live: Array<{ shell: OrchestrationV2ThreadShell; kept: boolean }> = [];
  for (const entry of pending) {
    const { record, shell } = entry.candidate;
    if (visited.has(record.id)) continue;
    visited.add(record.id);
    const kept = entry.kept || keepsTypedInBranch(entry.candidate);
    if (shell?.archivedAt === null && shell.deletedAt === null) live.push({ shell, kept });
    for (const child of localChildren.get(record.id) ?? [])
      pending.push({ candidate: child, kept });
  }
  return live;
}

const archiveCandidates = Effect.fn("LastCodePeerArchive.candidates")(function* (
  ownerIds: readonly ThreadId[],
  store: ArchiveInventoryStore,
) {
  const ids = new Set<ThreadId>();
  for (const id of ownerIds) {
    for (const candidate of yield* store.getArchiveFamilyThreadIds(id)) ids.add(candidate);
  }
  const candidates = yield* Effect.forEach(ids, (id) =>
    Effect.gen(function* () {
      const shell = yield* store.getThreadShell(id);
      // Deleted owners may still connect surviving descendants. A foreign seed can be absent here.
      const record = shell ?? (yield* store.findThread(id));
      return record === null ? null : { record, shell };
    }),
  );
  return candidates.filter((candidate) => candidate !== null);
});

export const readPeerArchiveOwnerScope = Effect.fn("LastCodePeerArchive.readOwnerScope")(function* (
  environmentId: EnvironmentId,
  rootId: ThreadId,
  store: ArchiveInventoryStore,
) {
  const candidates = yield* archiveCandidates([rootId], store);
  const children = new Map<ThreadId, ArchiveCandidate[]>();
  for (const candidate of candidates) {
    const owner = getThreadOwner(candidate.record, environmentId);
    if (owner?.environmentId !== environmentId) continue;
    const siblings = children.get(owner.threadId);
    if (siblings === undefined) children.set(owner.threadId, [candidate]);
    else siblings.push(candidate);
  }
  const owners = new Set([rootId]);
  const kept = new Set<ThreadId>();
  for (const id of owners) {
    for (const child of children.get(id) ?? []) {
      const childId = child.record.id;
      if (owners.has(childId)) continue;
      owners.add(childId);
      if (kept.has(id) || keepsTypedInBranch(child)) kept.add(childId);
    }
  }
  return {
    ownerEnvironmentId: environmentId,
    ownerThreadIds: [...owners],
    keptOwnerThreadIds: [...kept],
  } satisfies PeerArchiveInventoryInput;
});

export const readPeerArchiveInventory = Effect.fn("LastCodePeerArchive.readInventory")(function* <
  E,
>(
  environmentId: EnvironmentId,
  request: PeerArchiveInventoryInput,
  ports: {
    readonly store: ArchiveInventoryStore &
      Pick<ProjectionStoreV2Shape, "getThreadRecords" | "getThreadLatestAssistantMessageAt">;
    readonly authorize: (shell: OrchestrationV2ThreadShell) => Effect.Effect<void, E>;
  },
): Effect.fn.Return<PeerArchiveInventory, E | ProjectionStoreV2Error> {
  const candidates = yield* archiveCandidates(request.ownerThreadIds, ports.store);
  const live = liveInventory(environmentId, request, candidates);

  // A refusal is per environment. Never present a partial branch as an empty or complete inventory.
  for (const { shell } of live) yield* ports.authorize(shell);

  const threads: Array<PeerArchiveInventory["threads"][number]> = [];
  const typedInThreadIds: ThreadId[] = [];
  const activeThreadIds: ThreadId[] = [];
  const unreadThreadIds: ThreadId[] = [];
  const protectedThreadIds: ThreadId[] = [];
  const keptThreadIds: ThreadId[] = [];
  for (const { shell, kept } of live) {
    const controls = yield* ports.store.getThreadRecords(
      shell.id,
      ["runs", "runtimeRequests", "providerThreads", "providerTurns", "turnItems", "subagents"],
      { turnItemStatuses: ["pending", "running", "waiting"] },
    );
    const latestReply = yield* ports.store.getThreadLatestAssistantMessageAt(shell.id);
    threads.push({ threadId: shell.id, title: shell.title, projectId: shell.projectId });
    if (shell.latestUserAuthoredMessageAt != null) typedInThreadIds.push(shell.id);
    if (hasUnfinishedArchiveWork(controls)) activeThreadIds.push(shell.id);
    if (hasUnreadArchiveResponse(shell, latestReply)) unreadThreadIds.push(shell.id);
    if (shell.persistent === true) protectedThreadIds.push(shell.id);
    if (kept) keptThreadIds.push(shell.id);
  }
  return {
    environmentId,
    threads,
    typedInThreadIds,
    activeThreadIds,
    unreadThreadIds,
    protectedThreadIds,
    keptThreadIds,
  };
});
