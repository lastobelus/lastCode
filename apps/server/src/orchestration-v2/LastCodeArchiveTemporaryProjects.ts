import {
  ProjectId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadOwner,
} from "@t3tools/contracts";
import { getThreadOwner } from "@t3tools/shared/threadOwnership";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectService } from "../project/ProjectService.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export class ArchiveTemporaryProjects extends Context.Service<
  ArchiveTemporaryProjects,
  Pick<ProjectService["Service"], "listTemporaryOwnedBy" | "delete">
>()("t3/orchestration-v2/LastCodeArchiveTemporaryProjects/ArchiveTemporaryProjects") {}

export class WrappedProjectChanged extends Schema.TaggedError<WrappedProjectChanged>()(
  "WrappedProjectChanged",
  { projectId: ProjectId },
) {
  override get message() {
    return `Temporary project '${this.projectId}' changed after archive confirmation and was kept.`;
  }
}

export interface WrappedProjectDeletion {
  readonly owner: ThreadOwner;
  readonly expectedArchivedThreadIds: readonly ThreadId[];
  readonly allowedOwnerThreadIds: readonly ThreadId[];
}

function belongsToArchive(
  thread: OrchestrationV2ThreadShell,
  owner: ThreadOwner,
  allowedOwnerThreadIds: ReadonlySet<ThreadId>,
) {
  const currentOwner = getThreadOwner(thread, owner.environmentId);
  return (
    currentOwner === null ||
    (currentOwner.environmentId === owner.environmentId &&
      allowedOwnerThreadIds.has(currentOwner.threadId))
  );
}

export function readTemporaryProjectThreads(
  projects: Pick<ProjectService["Service"], "listTemporaryOwnedBy"> | undefined,
  projections: Pick<ProjectionStoreV2Shape, "getShellSnapshot">,
  owner: ThreadOwner | undefined,
) {
  if (projects === undefined || owner === undefined) return Effect.succeed([]);
  return projects.listTemporaryOwnedBy(owner).pipe(
    Effect.flatMap(({ projects }) =>
      Effect.forEach(projects, (project) =>
        projections.getShellSnapshot({ projectId: project.id }).pipe(
          Effect.map(({ threads, archivedThreads }) => ({
            projectId: project.id,
            title: project.title,
            threads: [...threads, ...archivedThreads],
          })),
        ),
      ),
    ),
  );
}

export function temporaryProjectArchiveOwners(
  family: readonly OrchestrationV2ThreadShell[],
  owner: ThreadOwner,
  selected: ReadonlySet<ThreadId>,
) {
  const byId = new Map(family.map((thread) => [thread.id, thread]));
  const allowed = new Set([owner.threadId]);
  for (const thread of family) {
    const path = new Set<ThreadId>();
    let current: OrchestrationV2ThreadShell | undefined = thread;
    while (current !== undefined && !path.has(current.id) && !allowed.has(current.id)) {
      if (current.archivedAt === null && !selected.has(current.id)) break;
      path.add(current.id);
      const parent = getThreadOwner(current, owner.environmentId);
      current =
        parent?.environmentId === owner.environmentId ? byId.get(parent.threadId) : undefined;
    }
    if (current !== undefined && allowed.has(current.id)) for (const id of path) allowed.add(id);
  }
  return allowed;
}

export function selectTemporaryProjects(
  projects: readonly {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly threads: readonly OrchestrationV2ThreadShell[];
  }[],
  owner: ThreadOwner | undefined,
  archiveIds: ReadonlySet<ThreadId>,
  allowedOwnerThreadIds: ReadonlySet<ThreadId>,
) {
  if (owner === undefined) return [];
  return projects.flatMap(({ projectId, title, threads }) =>
    threads.every(
      (thread) =>
        thread.persistent !== true &&
        belongsToArchive(thread, owner, allowedOwnerThreadIds) &&
        (thread.archivedAt === null ? archiveIds.has(thread.id) : thread.archivePending == null),
    )
      ? [{ projectId, title, threadIds: threads.map(({ id }) => id) }]
      : [],
  );
}

/** Recheck under the existing project and thread persistence locks before force-deleting history. */
export function canRemoveWrappedProject(
  threads: readonly OrchestrationV2ThreadShell[],
  { owner, expectedArchivedThreadIds, allowedOwnerThreadIds }: WrappedProjectDeletion,
) {
  const confirmed = new Set(expectedArchivedThreadIds);
  const allowed = new Set(allowedOwnerThreadIds);
  return threads.every(
    (thread) =>
      thread.archivedAt !== null &&
      confirmed.has(thread.id) &&
      belongsToArchive(thread, owner, allowed) &&
      thread.persistent !== true &&
      thread.archivePending == null,
  );
}
