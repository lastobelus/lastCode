import { LastCodeProjectRenameDialog } from "./LastCodeProjectRenameDialog";
import { LastCodeProjectGroupingDialog } from "./LastCodeProjectGroupingDialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
import { useLastCodeProjectMenus } from "./useLastCodeProjectMenus";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../logicalProject";
const mocks = vi.hoisted(() => ({
  openRename: (_member: SidebarProjectGroupMember) => {},
  openGrouping: (_member: SidebarProjectGroupMember) => {},
  getThreads: () => [] as readonly SidebarThreadSummary[],
  getThread: (_ref: ScopedThreadRef): SidebarThreadSummary | null => null,
  showProject: vi.fn(async () => {}),
  showThread: vi.fn(async () => {}),
  showBulk: vi.fn(async () => {}),
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
  ORCHESTRATION_OPERATE_DENIED_MESSAGE: "Read-only",
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => mocks.canOperate,
  readEnvironmentScope: () => mocks.canOperate,
}));
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

vi.mock("./useLastCodeProjectMenu", () => ({
  useLastCodeProjectMenu: (
    _project: SidebarProjectSnapshot,
    rename: (member: SidebarProjectGroupMember) => void,
    grouping: (member: SidebarProjectGroupMember) => void,
    getThreads: () => readonly SidebarThreadSummary[],
  ) => {
    mocks.openRename = rename;
    mocks.openGrouping = grouping;
    mocks.getThreads = getThreads;
    return mocks.showProject;
  },
}));
vi.mock("./useLastCodeThreadMenu", () => ({
  useLastCodeThreadMenu: (
    _project: SidebarProjectSnapshot,
    getThread: (ref: ScopedThreadRef) => SidebarThreadSummary | null,
  ) => {
    mocks.getThread = getThread;
    return mocks.showThread;
  },
}));
vi.mock("./useLastCodeBulkThreadMenu", () => ({ useLastCodeBulkThreadMenu: () => mocks.showBulk }));
const project: SidebarProjectSnapshot = {
  ...member,
  projectKey: "group",
  displayName: "Group",
  groupedProjectCount: 1,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [member],
  memberProjectRefs: [scopeProjectRef(member.environmentId, member.id)],
  remoteEnvironmentLabels: ["Target"],
};
const first = makeThreadFixture({
  id: ThreadId.make("collision"),
  environmentId: member.environmentId,
});
const second = makeThreadFixture({ ...first, environmentId: EnvironmentId.make("second-env") });
const editing: LastCodeThreadEditingCapabilities = {
  requestRename: vi.fn(),
  finishRename: vi.fn(),
  requestArchiveConfirmation: vi.fn(),
  cancelArchiveConfirmation: vi.fn(),
};
const annotations = {
  onEditAnnotation: vi.fn(),
  onResolveAnnotation: vi.fn(async () => {}),
  onSaveAnnotationBody: vi.fn(async () => true),
};
const navigate = vi.fn(async () => {});
const newThread = vi.fn(async () => null);
function Harness({ threads }: { threads: readonly SidebarThreadSummary[] }) {
  const map = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const { renameDialog, groupingDialog } = useLastCodeProjectMenus(
    project,
    map,
    editing,
    annotations,
    navigate,
    newThread,
  );
  return (
    <>
      <LastCodeProjectRenameDialog {...renameDialog} />
      <LastCodeProjectGroupingDialog {...groupingDialog} />
    </>
  );
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.canOperate = true;
  mocks.command.mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Project title"]')!;
describe("project-scoped menu and editor ownership", () => {
  it("keeps existing menu callbacks stable while event-time reads use refreshed scoped members", async () => {
    await act(() => root.render(<Harness threads={[first, second]} />));
    const getThread = mocks.getThread,
      getThreads = mocks.getThreads;
    const ref = scopeThreadRef(first.environmentId, first.id);
    expect(getThread(ref)).toBe(first);
    const refreshed = { ...second, title: "Updated second environment" };
    await act(() => root.render(<Harness threads={[refreshed]} />));
    expect(mocks.getThread).toBe(getThread);
    expect(mocks.getThreads).toBe(getThreads);
    expect(getThread(ref)).toBeNull();
    expect(getThread(scopeThreadRef(second.environmentId, second.id))).toBe(refreshed);
    expect(getThreads()).toEqual([refreshed]);
  });
  it("preserves the actual rename draft through member refresh and independent grouping open/close", async () => {
    await act(() => root.render(<Harness threads={[first]} />));
    await act(() => mocks.openRename(member));
    const draft = input();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        draft,
        "Unsaved title",
      );
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => root.render(<Harness threads={[{ ...first, title: "Refreshed thread" }]} />));
    expect(input()).toBe(draft);
    expect(input().value).toBe("Unsaved title");
    await act(() => mocks.openGrouping(member));
    const cancel = [...document.querySelectorAll("button")].findLast(
      (button) => button.textContent === "Cancel",
    )!;
    await act(() => cancel.click());
    expect(input()).toBe(draft);
    expect(input().value).toBe("Unsaved title");
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects denied rename entry without opening an editor or invoking a mutation", async () => {
    await act(() => root.render(<Harness threads={[first]} />));
    mocks.canOperate = false;
    await act(() => mocks.openRename(member));
    expect(input()).toBeNull();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Action unavailable" }),
    );
  });
});
