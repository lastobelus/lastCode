import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { buildLastCodeProjectMenu } from "./lastcodeProjectMenu";

function member(key: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make("project"),
    environmentId: EnvironmentId.make(key),
    title: "Project",
    workspaceRoot: `/work/${key}`,
    physicalProjectKey: key,
    environmentLabel: key,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
  };
}

describe("LastCode project context menu", () => {
  it("targets grouped actions to their exact environment member", () => {
    const a = member("environment-a");
    const b = member("environment-b");
    const menu = buildLastCodeProjectMenu({
      members: [
        { member: a, canOperate: true, removalBlocked: false },
        { member: b, canOperate: false, removalBlocked: false },
      ],
      groupedProjectCount: 2,
      isNoProjectGroup: false,
    });
    expect(menu.items.map((item) => item.label)).toEqual([
      "Rename",
      "Group into...",
      "Copy Path",
      "Open dashboard",
      "Project settings",
      "Remove",
    ]);
    expect(menu.items[0]?.children).toMatchObject([
      { id: "rename:environment-a", label: "environment-a — /work/environment-a" },
      { id: "rename:environment-b", disabled: true },
    ]);
    expect(menu.actions.get("copy-path:environment-b")).toEqual({ action: "copy-path", member: b });
    expect(menu.items[2]?.children?.every((item) => !item.disabled)).toBe(true);
    expect(menu.items[5]?.children?.[1]).toMatchObject({
      label: "environment-b — /work/environment-b",
      disabled: true,
      destructive: true,
    });
  });

  it("explains persistence protection only for protected grouped members", () => {
    const menu = buildLastCodeProjectMenu({
      members: [
        { member: member("protected"), canOperate: true, removalBlocked: true },
        { member: member("read-only"), canOperate: false, removalBlocked: false },
      ],
      groupedProjectCount: 2,
      isNoProjectGroup: false,
    });
    expect(menu.items[5]?.children).toMatchObject([
      {
        label: "protected — /work/protected (disable persistence first)",
        disabled: true,
      },
      { label: "read-only — /work/read-only", disabled: true },
    ]);
  });

  it("keeps a protected single member visible but unavailable for removal", () => {
    const menu = buildLastCodeProjectMenu({
      members: [{ member: member("environment-a"), canOperate: true, removalBlocked: true }],
      groupedProjectCount: 1,
      isNoProjectGroup: false,
    });
    expect(menu.items[5]).toEqual({
      id: "delete:environment-a",
      label: "Remove (disable persistence first)",
      destructive: true,
      disabled: true,
      icon: "trash",
    });
    expect(menu.items[0]?.children).toBeUndefined();
  });

  it("omits rename/grouping for No project while retaining member-specific paths", () => {
    const menu = buildLastCodeProjectMenu({
      members: ["environment-a", "environment-b"].map((key) => ({
        member: member(key),
        canOperate: true,
        removalBlocked: false,
      })),
      groupedProjectCount: 2,
      isNoProjectGroup: true,
    });
    expect(menu.items.map((item) => item.id)).toEqual([
      "copy-path:submenu",
      "open-dashboard",
      "project-settings",
      "delete:submenu",
    ]);
    expect(menu.actions.has("rename:environment-a")).toBe(false);
    expect(menu.actions.get("copy-path:environment-b")?.member.workspaceRoot).toBe(
      "/work/environment-b",
    );
  });
});
