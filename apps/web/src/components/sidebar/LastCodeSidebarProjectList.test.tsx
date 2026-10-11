// @vitest-environment happy-dom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DndContext, DragEndEvent } from "@dnd-kit/core";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../../uiStateStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { LastCodeSidebarProject } from "./LastCodeSidebarProject";
import { LastCodeSidebarProjectList } from "./LastCodeSidebarProjectList";
const mocks = vi.hoisted(() => ({
  manual: true,
  drag: null as ComponentProps<typeof DndContext> | null,
  animate: vi.fn(),
  props: null as ComponentProps<typeof LastCodeSidebarProject> | null,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSetting: () => (mocks.manual ? "manual" : "recent"),
}));
vi.mock("@formkit/auto-animate", () => ({ autoAnimate: mocks.animate }));
// Keep real list wrappers and the persisted reorder store; replace only the sensor transport.
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: ComponentProps<typeof DndContext>) => {
    mocks.drag = props;
    return <div>{props.children}</div>;
  },
  PointerSensor: {},
  useSensor: () => ({}),
  useSensors: () => [],
  pointerWithin: () => [],
  closestCorners: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setActivatorNodeRef: () => {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
  }),
}));
// A local editor probe isolates the real list's mount boundary, not project operation behavior.
vi.mock("./LastCodeSidebarProject", () => ({
  LastCodeSidebarProject: (props: ComponentProps<typeof LastCodeSidebarProject>) => {
    mocks.props = props;
    return (
      <>
        <input aria-label={props.project.projectKey} defaultValue="original" />
        <button onClick={() => props.onListExpandedChange(props.project.projectKey, true)}>
          {props.listExpanded ? "Expanded" : "Expand"}
        </button>
      </>
    );
  },
}));
function project(key: string, members: string[]): SidebarProjectSnapshot {
  const memberProjects = members.map((key, i) => ({
    id: ProjectId.make("collision"),
    environmentId: EnvironmentId.make(`env-${i}-${key}`),
    title: key,
    workspaceRoot: `/work/${key}`,
    physicalProjectKey: key,
    environmentLabel: key,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    createdAt: "2026-03-09T10:00:00Z",
    updatedAt: "2026-03-09T10:00:00Z",
    scripts: [],
  }));
  return {
    ...memberProjects[0]!,
    projectKey: key,
    displayName: key,
    groupedProjectCount: members.length,
    environmentPresence: "remote-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects,
    memberProjectRefs: memberProjects.map((m) => scopeProjectRef(m.environmentId, m.id)),
    remoteEnvironmentLabels: members,
  };
}
const grouped = project("group", ["one", "two"]),
  other = project("other", ["three"]);
const orderedKeys = ["one", "two", "three"];
const defaultProjects = [grouped, other];
function Harness({ projects = defaultProjects }: { projects?: readonly SidebarProjectSnapshot[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <LastCodeSidebarProjectList
      projects={projects}
      orderedProjectKeys={orderedKeys}
      activeRoute={{ projectKey: "group", threadKey: "env:thread" }}
      expandedLists={expanded}
      onExpandedChange={(key, value) =>
        setExpanded((current) => {
          const next = new Set(current);
          if (value) next.add(key);
          else next.delete(key);
          return next;
        })
      }
      jumpLabels={new Map()}
      newThread={{ handle: async () => null, shortcutLabel: null }}
    />
  );
}
let container: HTMLDivElement, root: Root;
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.manual = true;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  useUiStateStore.setState({ projectOrder: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useUiStateStore.setState({ projectOrder: [] });
  if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
const endEvent = (active: string, over: string | null) =>
  ({ active: { id: active }, over: over ? { id: over } : null }) as DragEndEvent;
describe("project list ordering and mount ownership", () => {
  it("moves all exact physical members, guards the post-drag click, and cancels without reordering", async () => {
    await act(() => root.render(<Harness />));
    const gestures = mocks.props!.gestures;
    await act(() =>
      mocks.drag!.onDragStart?.(
        {} as Parameters<NonNullable<ComponentProps<typeof DndContext>["onDragStart"]>>[0],
      ),
    );
    expect(gestures.dragInProgressRef.current).toBe(true);
    expect(gestures.suppressProjectClickAfterDragRef.current).toBe(true);
    await act(() => mocks.drag!.onDragEnd?.(endEvent("other", "group")));
    expect(useUiStateStore.getState().projectOrder).toEqual(["three", "one", "two"]);
    expect(gestures.dragInProgressRef.current).toBe(false);
    await act(() =>
      mocks.drag!.onDragCancel?.(
        {} as Parameters<NonNullable<ComponentProps<typeof DndContext>["onDragCancel"]>>[0],
      ),
    );
    expect(useUiStateStore.getState().projectOrder).toEqual(["three", "one", "two"]);
  });
  it("uses refreshed membership and ignores removed or missing drop targets", async () => {
    await act(() => root.render(<Harness />));
    const refreshed = project("group", ["one"]);
    await act(() => root.render(<Harness projects={[refreshed, other]} />));
    await act(() => mocks.drag!.onDragEnd?.(endEvent("other", "missing")));
    expect(useUiStateStore.getState().projectOrder).toEqual([]);
    await act(() => mocks.drag!.onDragEnd?.(endEvent("other", null)));
    expect(useUiStateStore.getState().projectOrder).toEqual([]);
    await act(() => mocks.drag!.onDragEnd?.(endEvent("group", "other")));
    expect(useUiStateStore.getState().projectOrder).toEqual(["two", "three", "one"]);
  });
  it("retains editor DOM on ordinary refresh, remounts across sort modes, and keeps owner expansion", async () => {
    await act(() => root.render(<Harness />));
    const editor = container.querySelector<HTMLInputElement>('input[aria-label="group"]')!;
    editor.value = "in progress";
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector('input[aria-label="group"]')).toBe(editor);
    expect(editor.value).toBe("in progress");
    mocks.manual = false;
    await act(() => root.render(<Harness />));
    const automaticEditor = container.querySelector<HTMLInputElement>('input[aria-label="group"]')!;
    expect(automaticEditor).not.toBe(editor);
    expect(automaticEditor.value).toBe("original");
    expect(container.querySelector("button")!.textContent).toBe("Expanded");
    expect(mocks.animate).toHaveBeenCalledTimes(1);
    await act(() => root.render(<Harness />));
    expect(container.querySelector('input[aria-label="group"]')).toBe(automaticEditor);
    expect(mocks.animate).toHaveBeenCalledTimes(1);
  });
});
