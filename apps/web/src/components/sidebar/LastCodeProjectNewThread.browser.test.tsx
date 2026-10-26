import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  NO_PROJECT_GROUP_KEY,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { LastCodeProjectNewThread } from "./LastCodeProjectNewThread";
const mocks = vi.hoisted(() => ({
  mobile: true,
  enabled: true,
  available: true,
  close: vi.fn(),
  toast: vi.fn(),
  show: vi.fn<(items: unknown[], position: { x: number; y: number }) => Promise<string | null>>(),
  parentClick: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSetting: () => mocks.enabled }));
vi.mock("../../localApi", () => ({
  readLocalApi: () => (mocks.available ? { contextMenu: { show: mocks.show } } : null),
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: mocks.mobile, setOpenMobile: mocks.close }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const create = vi.fn<ReturnType<typeof useNewThreadHandler>>();
function member(env: string): SidebarProjectGroupMember {
  return {
    id: ProjectId.make("same-project"),
    environmentId: EnvironmentId.make(env),
    title: env,
    workspaceRoot: `/workspace/${env}`,
    physicalProjectKey: `${env}:physical-key-with:colon`,
    environmentLabel: env,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    scripts: [],
  };
}
const first = member("first"),
  remote = member("remote");
function project(members = [first, remote], key = "group"): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey: key,
    displayName: "Project group",
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: members,
    memberProjectRefs: members.map((value) => scopeProjectRef(value.environmentId, value.id)),
    remoteEnvironmentLabels: ["remote"],
  };
}
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() =>
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  }),
);
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = true;
  mocks.enabled = true;
  mocks.available = true;
  mocks.show.mockResolvedValue(null);
  create.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function render(value = project(), handleNewThread = create) {
  await act(() =>
    root.render(
      <div onClick={mocks.parentClick}>
        <LastCodeProjectNewThread
          project={value}
          handleNewThread={handleNewThread}
          shortcutLabel="⌘N"
        />
      </div>,
    ),
  );
}
async function click() {
  await act(async () => {
    container
      .querySelector("button")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 25, clientY: 70 }),
      );
  });
}
function menu() {
  return mocks.show.mock.calls[0]![0] as { id: string; label: string }[];
}
describe("project New thread targeting", () => {
  it.each([true, false])(
    "creates a sole physical member manually with mobile=%s and isolates the header click",
    async (mobile) => {
      mocks.mobile = mobile;
      await render(project([remote]));
      await click();
      expect(create).toHaveBeenCalledExactlyOnceWith(
        scopeProjectRef(remote.environmentId, remote.id),
        { environmentSelection: "manual" },
      );
      expect(mocks.show).not.toHaveBeenCalled();
      expect(mocks.parentClick).not.toHaveBeenCalled();
      if (mobile) {
        expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
        expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
          create.mock.invocationCallOrder[0]!,
        );
      } else expect(mocks.close).not.toHaveBeenCalled();
    },
  );
  it.each([remote.physicalProjectKey, "auto"])(
    "routes grouped choice %s through the existing creation path",
    async (choice) => {
      let resolve!: (value: string) => void;
      const pending = new Promise<string>((done) => {
        resolve = done;
      });
      mocks.show.mockReturnValueOnce(pending);
      await render();
      await click();
      expect(create).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.show.mock.calls[0]![1]).toEqual({ x: 25, y: 70 });
      expect(menu().map((item) => item.id)).toEqual([
        "auto",
        first.physicalProjectKey,
        remote.physicalProjectKey,
      ]);
      await act(async () => {
        resolve(choice);
        await pending;
      });
      const target = choice === "auto" ? first : remote;
      expect(create).toHaveBeenCalledExactlyOnceWith(
        scopeProjectRef(target.environmentId, target.id),
        { environmentSelection: choice === "auto" ? "auto" : "manual" },
      );
      expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
  it.each(["disabled", "same environment", "No project"])(
    "omits auto balancing for %s",
    async (reason) => {
      mocks.enabled = reason !== "disabled";
      const members =
        reason === "same environment"
          ? [first, { ...remote, environmentId: first.environmentId }]
          : [first, remote];
      await render(project(members, reason === "No project" ? NO_PROJECT_GROUP_KEY : "group"));
      await click();
      expect(menu().map((item) => item.id)).toEqual([
        first.physicalProjectKey,
        remote.physicalProjectKey,
      ]);
    },
  );
  it.each([null, "unknown:member"])(
    "does not create or close the sheet for cancelled/unknown choice %s",
    async (choice) => {
      mocks.show.mockResolvedValueOnce(choice);
      await render();
      await click();
      expect(create).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );
  it("does nothing when the chooser API is absent", async () => {
    mocks.available = false;
    await render();
    await click();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("reports chooser failure without creating or closing the mobile sheet", async () => {
    mocks.show.mockRejectedValueOnce(new Error("Chooser failed"));
    await render();
    await click();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not choose environment",
      description: "Chooser failed",
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("retains the create failure report after closing the mobile sheet", async () => {
    create.mockRejectedValueOnce(new Error("Create failed"));
    await render(project([remote]));
    await click();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not create thread",
      description: "Create failed",
    });
  });
  it("uses the refreshed physical member and creation callback on the next click", async () => {
    await render(project([first]));
    const button = container.querySelector("button");
    const refreshed = { ...remote, id: ProjectId.make("new-project") };
    const newer = vi.fn<ReturnType<typeof useNewThreadHandler>>().mockResolvedValue(null);
    await render(project([refreshed]), newer);
    expect(container.querySelector("button")).toBe(button);
    await click();
    expect(create).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledExactlyOnceWith(
      scopeProjectRef(refreshed.environmentId, refreshed.id),
      { environmentSelection: "manual" },
    );
  });
});
