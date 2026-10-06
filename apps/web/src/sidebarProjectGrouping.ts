import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroup,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";
export const NO_PROJECT_GROUP_KEY = "builtin:no-project";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktop-local environment. The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // local-device treatment instead of the generic remote treatment.
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

interface SidebarProjectGroupingInput {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  scratchWorkspaceRootsByEnvironmentId?: ReadonlyMap<EnvironmentId, string>;
}

function buildSidebarProjectGroups(
  input: SidebarProjectGroupingInput,
): ReadonlyArray<ProjectGroup<Project>> {
  const scratchProjects: Project[] = [];
  const ordinaryProjects: Project[] = [];
  const projectOrder = new Map<string, number>();
  for (const [index, project] of input.projects.entries()) {
    const physicalKey = derivePhysicalProjectKey(project);
    if (!projectOrder.has(physicalKey)) projectOrder.set(physicalKey, index);
    const scratchRoot = input.scratchWorkspaceRootsByEnvironmentId?.get(project.environmentId);
    (isScratchProject(project, scratchRoot) ? scratchProjects : ordinaryProjects).push(project);
  }
  const grouping = {
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  };
  const groups = buildProjectGroups({ ...grouping, projects: ordinaryProjects });
  if (scratchProjects.length === 0) return groups;

  // Only the sidebar shares this group. Physical project refs and draft keys
  // stay environment-local, so creating or opening a thread keeps its machine.
  const scratchGroups = buildProjectGroups({ ...grouping, projects: scratchProjects });
  const members = scratchGroups.flatMap((group) => group.members);
  const representative =
    members.find((member) => member.project.environmentId === input.primaryEnvironmentId)
      ?.project ?? members[0]!.project;
  const noProjectGroup: ProjectGroup<Project> = {
    key: NO_PROJECT_GROUP_KEY,
    label: "No project",
    representative,
    members,
    memberProjectRefs: scratchGroups.flatMap((group) => group.memberProjectRefs),
  };
  const scratchOrder = projectOrder.get(derivePhysicalProjectKey(scratchProjects[0]!))!;
  const insertionIndex = groups.findIndex(
    (group) => projectOrder.get(group.members[0]!.physicalProjectKey)! > scratchOrder,
  );
  const index = insertionIndex === -1 ? groups.length : insertionIndex;
  return [...groups.slice(0, index), noProjectGroup, ...groups.slice(index)];
}

export function buildPhysicalToLogicalProjectKeyMap(
  input: SidebarProjectGroupingInput,
): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildSidebarProjectGroups(input);
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(
  input: SidebarProjectGroupingInput & {
    resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
    // Returns true when an env id maps to a desktop-local saved-env
    // record. Defaults to "false for every
    // env" so callers that don't care about the distinction get the
    // legacy behavior.
    isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
    isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
  },
): SidebarProjectSnapshot[] {
  return buildSidebarProjectGroups(input).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const isWsl = input.isWslEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const allRemoteMembersAreWsl =
      remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

    return {
      ...representative,
      projectKey: group.key,
      displayName: group.label,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      allRemoteMembersAreWsl,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
    };
  });
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}
