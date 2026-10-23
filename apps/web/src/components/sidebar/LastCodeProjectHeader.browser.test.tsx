import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  useUiStateStore,
  resolveProjectExpanded,
  legacyProjectCwdPreferenceKey,
} from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { SidebarProvider } from "../ui/sidebar";
import { LastCodeProjectHeader, type LastCodeProjectDragHandle } from "./LastCodeProjectHeader";
import { lastCodeProjectExpansionPreferenceKeys } from "./useLastCodeProjectHeaderGestures";
const mocks = vi.hoisted(() => ({
  menu: vi.fn(async (_position: { x: number; y: number }) => {}),
  pointer: vi.fn(),
  parent: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: string) => (key === "lastcodeStatusIcons" ? {} : 90),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => <span>Favicon</span> }));
vi.mock("../../environmentIcons", () => ({ ConnectedEnvironmentIcon: () => null }));
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
const value = project();
const keys = lastCodeProjectExpansionPreferenceKeys(value);
const gestures = {
  dragInProgressRef: { current: false },
  suppressProjectClickAfterDragRef: { current: false },
  suppressProjectClickForContextMenuRef: { current: false },
};
const attach = vi.fn();
const handle: LastCodeProjectDragHandle = {
  setActivatorNodeRef: attach,
  attributes: {
    role: "button",
    tabIndex: 0,
    "aria-disabled": false,
    "aria-pressed": undefined,
    "aria-roledescription": "sortable",
    "aria-describedby": "sort-help",
  },
  listeners: { onPointerDown: mocks.pointer },
};
function Harness({ manual = true }: { manual?: boolean }) {
  const expanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, keys),
  );
  return (
    <SidebarProvider>
      <div onPointerDown={mocks.parent}>
        <LastCodeProjectHeader
          project={value}
          expanded={expanded}
          status={null}
          environments={[]}
          latestThreadTimestamp={null}
          drag={{ manual, handle }}
          gestures={gestures}
          showMenu={mocks.menu}
        >
          <button onClick={(event) => event.stopPropagation()}>New thread</button>
        </LastCodeProjectHeader>
      </div>
    </SidebarProvider>
  );
}
function setup() {
  const ui = useUiStateStore.getState();
  const selection = useThreadSelectionStore.getState();
  vi.clearAllMocks();
  gestures.dragInProgressRef.current = false;
  gestures.suppressProjectClickAfterDragRef.current = false;
  gestures.suppressProjectClickForContextMenuRef.current = false;
  useUiStateStore.setState({ projectExpandedById: {} });
  useThreadSelectionStore.getState().clearSelection();
  return {
    [Symbol.dispose]() {
      useUiStateStore.setState(ui);
      useThreadSelectionStore.setState(selection);
    },
  };
}
async function renderHeader(manual = true) {
  const screen = await render(<Harness manual={manual} />, { router: false });
  const button = () =>
    screen.container.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')!;
  return Object.assign(screen, { button, click: () => act(() => button().click()) });
}
const expanded = () => resolveProjectExpanded(useUiStateStore.getState().projectExpandedById, keys);
describe("project header gestures", () => {
  it("toggles logical, physical and legacy preferences and clears selection on ordinary click", async () => {
    using _fixture = setup();
    await using screen = await renderHeader();
    const { click } = screen;
    useThreadSelectionStore.getState().toggleThread("selected");
    await click();
    expect(expanded()).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    expect(useUiStateStore.getState().projectExpandedById).toEqual(
      Object.fromEntries(
        [
          value.projectKey,
          ...value.memberProjects.map((member) => member.physicalProjectKey),
          ...value.memberProjects.map((member) =>
            legacyProjectCwdPreferenceKey(member.workspaceRoot),
          ),
        ].map((key) => [key, false]),
      ),
    );
    await click();
    expect(expanded()).toBe(true);
  });
  it.each(["context", "dragging", "after drag"])(
    "suppresses %s click without clearing selection or toggling",
    async (reason) => {
      using _fixture = setup();
      await using screen = await renderHeader();
      const { click } = screen;
      useThreadSelectionStore.getState().toggleThread("selected");
      if (reason === "context") gestures.suppressProjectClickForContextMenuRef.current = true;
      if (reason === "dragging") gestures.dragInProgressRef.current = true;
      if (reason === "after drag") gestures.suppressProjectClickAfterDragRef.current = true;
      await click();
      expect(expanded()).toBe(true);
      expect(useThreadSelectionStore.getState().selectedThreadKeys.has("selected")).toBe(true);
      await click();
      expect(expanded()).toBe(reason === "dragging");
    },
  );
  it.each(["Enter", " "])(
    "toggles with %s, preserves selection and blocks during drag",
    async (key) => {
      using _fixture = setup();
      await using screen = await renderHeader();
      const { button } = screen;
      useThreadSelectionStore.getState().toggleThread("selected");
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => button().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(expanded()).toBe(false);
      expect(useThreadSelectionStore.getState().selectedThreadKeys.has("selected")).toBe(true);
      gestures.dragInProgressRef.current = true;
      await act(() =>
        button().dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        ),
      );
      expect(expanded()).toBe(false);
    },
  );
  it("leaves unrelated keys unchanged", async () => {
    using _fixture = setup();
    await using screen = await renderHeader();
    const { button } = screen;
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    await act(() => button().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(expanded()).toBe(true);
  });
  it("opens context menu at native coordinates and suppresses its following click", async () => {
    using _fixture = setup();
    await using screen = await renderHeader();
    const { button, click } = screen;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 35,
    });
    await act(() => button().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.menu).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 35 });
    await click();
    expect(expanded()).toBe(true);
  });
  it.each(["MacIntel", "Win32"])(
    "prevents context pointer starting sort on %s and keeps ordinary sorting",
    async (platform) => {
      using _fixture = setup();
      const prior = Object.getOwnPropertyDescriptor(navigator, "platform");
      Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
      try {
        await using screen = await renderHeader();
        const { button } = screen;
        gestures.suppressProjectClickAfterDragRef.current = true;
        gestures.suppressProjectClickForContextMenuRef.current = true;
        await act(() =>
          button().dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              button: platform === "MacIntel" ? 0 : 2,
              ctrlKey: platform === "MacIntel",
            }),
          ),
        );
        expect(mocks.pointer).not.toHaveBeenCalled();
        expect(mocks.parent).not.toHaveBeenCalled();
        expect(gestures.suppressProjectClickAfterDragRef.current).toBe(false);
        expect(gestures.suppressProjectClickForContextMenuRef.current).toBe(false);
        await act(() =>
          button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })),
        );
        expect(mocks.pointer).toHaveBeenCalledTimes(1);
        expect(mocks.parent).toHaveBeenCalledTimes(1);
      } finally {
        if (prior) Object.defineProperty(navigator, "platform", prior);
        else Reflect.deleteProperty(navigator, "platform");
      }
    },
  );
  it("detaches sortable activation/listeners on automatic sorting without remounting the header", async () => {
    using _fixture = setup();
    await using screen = await renderHeader();
    const { button, click } = screen;
    const before = button();
    expect(attach).toHaveBeenLastCalledWith(before);
    await screen.rerender(<Harness manual={false} />);
    expect(button()).toBe(before);
    expect(attach).toHaveBeenLastCalledWith(null);
    await act(() =>
      button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })),
    );
    expect(mocks.pointer).not.toHaveBeenCalled();
    await click();
    expect(expanded()).toBe(false);
  });
  it("keeps the overlaid New thread action isolated from expansion", async () => {
    using _fixture = setup();
    await using screen = await renderHeader();
    const { container } = screen;
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((value) => value.textContent === "New thread")!
        .click(),
    );
    expect(expanded()).toBe(true);
  });
});
