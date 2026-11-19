import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  SidebarProjectSnapshot,
  SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import {
  NO_PROJECT_GROUP_KEY,
  resolveSidebarProjectSettingsKey,
} from "../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../logicalProject";
import type { SidebarThreadSummary } from "../../types";
import {
  readProject,
  readThreadShell,
  readEnvironmentSupportsThreadAnnotations,
  readEnvironmentSupportsPersistence,
} from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { readThreadHandoffs } from "../../handoffs/handoffsStore";
import { describeHandoff } from "../../handoffs/handoffMenu";
import { lastcodeSidebarCreatorDetails } from "../lastcodeSidebarFamilies.logic";
import { buildLastCodeThreadMenu } from "./lastcodeThreadMenu";

/** Resolve the exact physical project before reading thread-menu capabilities. */
export function readLastCodeThreadMenuProject(
  thread: SidebarThreadSummary,
  project: SidebarProjectSnapshot,
  members: ReadonlyMap<string, SidebarProjectGroupMember>,
  settings: ProjectGroupingSettings,
) {
  const projectRef = scopeProjectRef(thread.environmentId, thread.projectId);
  const threadProject = readProject(projectRef) ?? members.get(scopedProjectKey(projectRef));
  const projectSettingsKey = threadProject
    ? resolveSidebarProjectSettingsKey({
        sidebarProjectKey: project.projectKey,
        targetProject: threadProject,
        settings,
      })
    : project.projectKey === NO_PROJECT_GROUP_KEY
      ? null
      : project.projectKey;
  const workspacePath =
    thread.worktreePath ?? threadProject?.workspaceRoot ?? project.workspaceRoot ?? null;
  return { projectSettingsKey, workspacePath };
}

// Read at menu-open time; actions retain this snapshot while their command guards reread authority.
export function readLastCodeThreadMenuTarget(
  thread: SidebarThreadSummary,
  projectTarget: ReturnType<typeof readLastCodeThreadMenuProject>,
  handoffsLimit: number,
  hasStoppableProcesses: boolean,
) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { projectSettingsKey, workspacePath } = projectTarget;
  const creatorRef = thread.creatorThreadId
    ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
    : null;
  const creator = lastcodeSidebarCreatorDetails(
    thread,
    creatorRef ? readThreadShell(creatorRef) : null,
  );
  const handoffs = readThreadHandoffs(threadRef);
  const descriptors = handoffs.slice(0, handoffsLimit).map(describeHandoff);
  const items = buildLastCodeThreadMenu({
    thread,
    creator,
    canAnnotate:
      readEnvironmentSupportsThreadAnnotations(thread.environmentId) &&
      thread.latestUserMessageAt !== null,
    supportsPersistence: readEnvironmentSupportsPersistence(thread.environmentId),
    hasStoppableProcesses,
    projectSettingsKey,
    handoffs: {
      entries: descriptors.map(({ entry, label }) => ({ id: entry.id, label })),
      hasMore: handoffs.length > descriptors.length,
    },
    canOperate: readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  });
  return {
    thread,
    threadRef,
    projectSettingsKey,
    workspacePath,
    creator: { ...creator, ref: creatorRef },
    handoffs,
    items,
  };
}
export type LastCodeThreadMenuTarget = ReturnType<typeof readLastCodeThreadMenuTarget>;
