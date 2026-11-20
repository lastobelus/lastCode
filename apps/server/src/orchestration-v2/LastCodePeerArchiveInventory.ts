import {
  type EnvironmentId,
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
  "getThreadShell" | "getArchiveFamilyThreadIds"
>;

function liveInventory(
  environmentId: EnvironmentId,
  request: PeerArchiveInventoryInput,
  shells: readonly OrchestrationV2ThreadShell[],
) {
  const ownerIds = new Set(request.ownerThreadIds);
  const keptOwners = new Set(request.keptOwnerThreadIds);
  const localChildren = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  const pending: Array<{
    shell: OrchestrationV2ThreadShell;
    kept: boolean;
  }> = [];
  for (const shell of shells) {
    const owner = getThreadOwner(shell, environmentId);
    if (owner === null) continue;
    if (owner.environmentId === environmentId) {
      const siblings = localChildren.get(owner.threadId);
      if (siblings === undefined) localChildren.set(owner.threadId, [shell]);
      else siblings.push(shell);
    } else if (owner.environmentId === request.ownerEnvironmentId && ownerIds.has(owner.threadId)) {
      pending.push({ shell, kept: keptOwners.has(owner.threadId) });
    }
  }

  const visited = new Set<ThreadId>();
  const live: Array<{ shell: OrchestrationV2ThreadShell; kept: boolean }> = [];
  for (const entry of pending) {
    if (visited.has(entry.shell.id)) continue;
    visited.add(entry.shell.id);
    const { shell } = entry;
    const kept = entry.kept || shell.latestUserAuthoredMessageAt != null;
    if (shell.archivedAt === null) live.push({ shell, kept });
    for (const child of localChildren.get(shell.id) ?? []) pending.push({ shell: child, kept });
  }
  return live;
}

const candidateShells = Effect.fn("LastCodePeerArchive.candidateShells")(function* (
  ownerIds: readonly ThreadId[],
  store: ArchiveInventoryStore,
) {
  const ids = new Set<ThreadId>();
  for (const id of ownerIds) {
    for (const candidate of yield* store.getArchiveFamilyThreadIds(id)) ids.add(candidate);
  }
  const shells = yield* Effect.forEach(ids, store.getThreadShell);
  return shells.filter((shell) => shell !== null).filter((shell) => shell.deletedAt === null);
});

export const readPeerArchiveOwnerScope = Effect.fn("LastCodePeerArchive.readOwnerScope")(function* (
  environmentId: EnvironmentId,
  rootId: ThreadId,
  store: ArchiveInventoryStore,
) {
  const shells = yield* candidateShells([rootId], store);
  const children = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const shell of shells) {
    const owner = getThreadOwner(shell, environmentId);
    if (owner?.environmentId !== environmentId) continue;
    const siblings = children.get(owner.threadId);
    if (siblings === undefined) children.set(owner.threadId, [shell]);
    else siblings.push(shell);
  }
  const owners = new Set([rootId]);
  const kept = new Set<ThreadId>();
  for (const id of owners) {
    for (const child of children.get(id) ?? []) {
      if (owners.has(child.id)) continue;
      owners.add(child.id);
      if (kept.has(id) || child.latestUserAuthoredMessageAt != null) kept.add(child.id);
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
  const shells = yield* candidateShells(request.ownerThreadIds, ports.store);
  const live = liveInventory(environmentId, request, shells);

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
