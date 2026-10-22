import { act, render, type Screen } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../logicalProject";
import { deriveProjectGroupingOverrideKey } from "../../logicalProject";
import { LastCodeProjectRenameDialog } from "./LastCodeProjectRenameDialog";
import { LastCodeProjectGroupingDialog } from "./LastCodeProjectGroupingDialog";
const mocks = vi.hoisted(() => ({
  command: vi.fn<(value: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  settings: {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  } as ProjectGroupingSettings,
  update: vi.fn(),
  canOperate: true,
  toast: vi.fn(),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: "update" } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.command,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canOperate }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ProjectGroupingSettings) => unknown) =>
    select(mocks.settings),
  updateClientSettings: mocks.update,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const member: SidebarProjectGroupMember = {
  id: ProjectId.make("same-id"),
  environmentId: EnvironmentId.make("target-env"),
  title: "Original",
  workspaceRoot: "/work/project",
  physicalProjectKey: "target-env:project",
  environmentLabel: "Target",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  createdAt: "2026-03-09T10:00:00Z",
  updatedAt: "2026-03-09T10:00:00Z",
  scripts: [],
};
function setup() {
  vi.clearAllMocks();
  mocks.command.mockResolvedValue(AsyncResult.success(undefined));
  mocks.canOperate = true;
  mocks.settings = {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  };
}
async function rename(screen: Screen, target: SidebarProjectGroupMember | null, onClose = vi.fn()) {
  await screen.rerender(<LastCodeProjectRenameDialog target={target} onClose={onClose} />);
  return onClose;
}
async function grouping(
  screen: Screen,
  target: SidebarProjectGroupMember | null,
  onClose = vi.fn(),
) {
  await screen.rerender(<LastCodeProjectGroupingDialog target={target} onClose={onClose} />);
  return onClose;
}
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Project title"]')!;
async function draft(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (x) => x.textContent === label,
  );
  expect(button).toBeDefined();
  await act(() => button!.click());
}
describe("project dialog draft lifetimes", () => {
  it("retains a rename draft through refresh, but resets for close/reopen and same-id other environment", async () => {
    setup();
    await using screen = await render(null);
    await rename(screen, member);
    await draft("Unsaved");
    await rename(screen, { ...member, title: "Refreshed", updatedAt: "2026-03-10T10:00:00Z" });
    expect(input().value).toBe("Unsaved");
    await rename(screen, null);
    await rename(screen, member);
    expect(input().value).toBe("Original");
    await draft("Again");
    await rename(screen, {
      ...member,
      environmentId: EnvironmentId.make("other-env"),
      title: "Other member",
    });
    expect(input().value).toBe("Other member");
  });
  it("keeps the renamed draft and dialog open on mutation failure, then closes on success", async () => {
    setup();
    await using screen = await render(null);
    const close = await rename(screen, member);
    await draft("  New title  ");
    mocks.command.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Denied"))));
    await click("Save");
    expect(close).not.toHaveBeenCalled();
    expect(input().value).toBe("  New title  ");
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to rename project" }),
    );
    expect(mocks.command).toHaveBeenCalledWith({
      environmentId: member.environmentId,
      input: { projectId: member.id, title: "New title" },
    });
    await click("Save");
    expect(close).toHaveBeenCalledOnce();
  });
  it("validates empty titles and closes an unchanged title without mutation", async () => {
    setup();
    await using screen = await render(null);
    const close = await rename(screen, member);
    await draft("   ");
    await click("Save");
    expect(close).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project title cannot be empty" }),
    );
    await draft(" Original ");
    await click("Save");
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("disables rename input and save for a read-only target", async () => {
    setup();
    await using screen = await render(null);
    mocks.canOperate = false;
    await rename(screen, member);
    expect(input().disabled).toBe(true);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (x) => x.textContent === "Save",
      )?.disabled,
    ).toBe(true);
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("retains grouping selection through override refresh and writes only the exact client preference", async () => {
    setup();
    await using screen = await render(null);
    const key = deriveProjectGroupingOverrideKey(member);
    mocks.settings = {
      ...mocks.settings,
      sidebarProjectGroupingOverrides: {
        [key]: "separate",
        other: "repository_path",
      },
    };
    const close = await grouping(screen, member);
    mocks.settings = {
      ...mocks.settings,
      sidebarProjectGroupingOverrides: {
        [key]: "repository",
        other: "repository_path",
      },
    };
    await grouping(screen, { ...member, title: "Refresh" }, close);
    await click("Save");
    expect(mocks.update).toHaveBeenCalledWith({
      sidebarProjectGroupingOverrides: { [key]: "separate", other: "repository_path" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("reopens with current overrides and inherit deletes only its own override", async () => {
    setup();
    await using screen = await render(null);
    const key = deriveProjectGroupingOverrideKey(member);
    mocks.settings = {
      ...mocks.settings,
      sidebarProjectGroupingOverrides: {
        [key]: "separate",
        other: "repository_path",
      },
    };
    await grouping(screen, member);
    await grouping(screen, null);
    mocks.settings = {
      ...mocks.settings,
      sidebarProjectGroupingOverrides: { other: "repository_path" },
    };
    await grouping(screen, member);
    await click("Save");
    expect(mocks.update).toHaveBeenCalledWith({
      sidebarProjectGroupingOverrides: { other: "repository_path" },
    });
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
