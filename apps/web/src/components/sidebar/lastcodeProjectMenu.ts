import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

type ProjectAction = "rename" | "grouping" | "copy-path" | "delete";
interface ProjectMenuMember {
  member: SidebarProjectGroupMember;
  canOperate: boolean;
  removalBlocked: boolean;
}

export function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) return member.title;
  return member.environmentLabel
    ? `${member.environmentLabel}: ${member.workspaceRoot}`
    : member.workspaceRoot;
}

function actionDisabled(action: ProjectAction, target: ProjectMenuMember): boolean {
  if (action === "rename") return !target.canOperate;
  if (action === "delete") return target.removalBlocked || !target.canOperate;
  return false;
}

function memberActionItem(
  action: ProjectAction,
  target: ProjectMenuMember,
  groupedProjectCount: number,
): ContextMenuItem<string> {
  const disabled = actionDisabled(action, target);
  const label = formatProjectMemberActionLabel(target.member, groupedProjectCount);
  return {
    id: `${action}:${target.member.physicalProjectKey}`,
    label:
      action === "delete" && target.removalBlocked ? `${label} (disable persistence first)` : label,
    ...(action === "delete" ? { destructive: true } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

function targetedActionItem(
  action: ProjectAction,
  label: string,
  members: readonly ProjectMenuMember[],
  groupedProjectCount: number,
): ContextMenuItem<string> {
  const icon = action === "delete" ? { icon: "trash" as const } : {};
  if (members.length === 1) {
    return { ...memberActionItem(action, members[0]!, groupedProjectCount), label, ...icon };
  }
  return {
    id: `${action}:submenu`,
    label,
    ...icon,
    children: members.map((target) => memberActionItem(action, target, groupedProjectCount)),
  };
}

export function buildLastCodeProjectMenu(input: {
  members: readonly ProjectMenuMember[];
  groupedProjectCount: number;
  isNoProjectGroup: boolean;
}) {
  const { members, groupedProjectCount, isNoProjectGroup } = input;
  const actions = new Map<string, { action: ProjectAction; member: SidebarProjectGroupMember }>();
  const targeted = (action: ProjectAction, label: string) => {
    for (const { member } of members) {
      actions.set(`${action}:${member.physicalProjectKey}`, { action, member });
    }
    return targetedActionItem(action, label, members, groupedProjectCount);
  };
  const items: ContextMenuItem<string>[] = [];
  if (!isNoProjectGroup) {
    items.push(targeted("rename", "Rename"), targeted("grouping", "Group into..."));
  }
  items.push(
    targeted("copy-path", "Copy Path"),
    { id: "open-dashboard", label: "Open dashboard", icon: "layout-dashboard" },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    targeted(
      "delete",
      members.length === 1 && members[0]!.removalBlocked
        ? "Remove (disable persistence first)"
        : "Remove",
    ),
  );
  return { items, actions };
}
