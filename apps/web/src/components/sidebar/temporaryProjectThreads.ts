import { isTemporaryProject } from "@t3tools/client-runtime/state/temporary-projects";
import type { Project, SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

/** Keep threads usable in folder mode even when their project header is hidden. */
export function temporaryProjectThreadsOutsideFolders<Thread extends SidebarThreadSummary>(
  threads: readonly Thread[],
  groups: readonly SidebarProjectSnapshot[],
  projectByKey: ReadonlyMap<string, Project>,
): readonly Thread[] {
  const folderProjectKeys = new Set(
    groups.flatMap((group) =>
      group.memberProjectRefs.map(
        ({ environmentId, projectId }) => `${environmentId}:${projectId}`,
      ),
    ),
  );
  return threads.filter((thread) => {
    const key = `${thread.environmentId}:${thread.projectId}`;
    const project = projectByKey.get(key);
    return project !== undefined && isTemporaryProject(project) && !folderProjectKeys.has(key);
  });
}
