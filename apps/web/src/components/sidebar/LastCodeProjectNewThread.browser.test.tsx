import { act, render, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
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

async function show(screen: Screen, value = project(), handleNewThread = create) {
  await act(() =>
    screen.rerender(
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
async function click(container: HTMLElement) {
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
      setup();
      await using screen = await render(null);

      mocks.mobile = mobile;
      await show(screen, project([remote]));
      await click(screen.container);
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
      setup();
      await using screen = await render(null);

      let resolve!: (value: string) => void;
      const pending = new Promise<string>((done) => {
        resolve = done;
      });
      mocks.show.mockReturnValueOnce(pending);
      await show(screen);
      await click(screen.container);
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
      setup();
      await using screen = await render(null);

      mocks.enabled = reason !== "disabled";
      const members =
        reason === "same environment"
          ? [first, { ...remote, environmentId: first.environmentId }]
          : [first, remote];
      await show(
        screen,
        project(members, reason === "No project" ? NO_PROJECT_GROUP_KEY : "group"),
      );
      await click(screen.container);
      expect(menu().map((item) => item.id)).toEqual([
        first.physicalProjectKey,
        remote.physicalProjectKey,
      ]);
    },
  );
  it.each([null, "unknown:member"])(
    "does not create or close the sheet for cancelled/unknown choice %s",
    async (choice) => {
      setup();
      await using screen = await render(null);

      mocks.show.mockResolvedValueOnce(choice);
      await show(screen);
      await click(screen.container);
      expect(create).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );
  it("does nothing when the chooser API is absent", async () => {
    setup();
    await using screen = await render(null);

    mocks.available = false;
    await show(screen);
    await click(screen.container);
    expect(mocks.show).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("reports chooser failure without creating or closing the mobile sheet", async () => {
    setup();
    await using screen = await render(null);

    mocks.show.mockRejectedValueOnce(new Error("Chooser failed"));
    await show(screen);
    await click(screen.container);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not choose environment",
      description: "Chooser failed",
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("retains the create failure report after closing the mobile sheet", async () => {
    setup();
    await using screen = await render(null);

    create.mockRejectedValueOnce(new Error("Create failed"));
    await show(screen, project([remote]));
    await click(screen.container);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not create thread",
      description: "Create failed",
    });
  });
  it("uses the refreshed physical member and creation callback on the next click", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    await show(screen, project([first]));
    const button = container.querySelector("button");
    const refreshed = { ...remote, id: ProjectId.make("new-project") };
    const newer = vi.fn<ReturnType<typeof useNewThreadHandler>>().mockResolvedValue(null);
    await show(screen, project([refreshed]), newer);
    expect(container.querySelector("button")).toBe(button);
    await click(screen.container);
    expect(create).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledExactlyOnceWith(
      scopeProjectRef(refreshed.environmentId, refreshed.id),
      { environmentSelection: "manual" },
    );
  });
});

function setup() {
  vi.clearAllMocks();
  mocks.mobile = true;
  mocks.enabled = true;
  mocks.available = true;
  mocks.show.mockResolvedValue(null);
  create.mockResolvedValue(null);
}
