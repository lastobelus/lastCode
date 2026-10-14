// @vitest-environment happy-dom
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DndContext } from "@dnd-kit/core";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { useUiStateStore } from "../../uiStateStore";
import type { LastCodeSidebarProject } from "./LastCodeSidebarProject";
import { LastCodeSidebarContent } from "./LastCodeSidebarContent";
import { useLastCodeProjectThreads } from "./useLastCodeProjectThreads";
import { indexLastCodeSidebarThreads } from "./lastcodeSidebarProjects";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
const mocks = vi.hoisted(() => ({
  manual: true,
  drag: null as ComponentProps<typeof DndContext> | null,
  animate: vi.fn(),
  props: null as ComponentProps<typeof LastCodeSidebarProject> | null,
}));
const settings = {
  sidebarThreadSortOrder: "created_at",
  sidebarThreadPreviewCount: 1,
  legacySidebarThreadGroupingStyle: "minimal",
  lastcodeSidebarFamilyStatusSubheaders: true,
  legacySidebarScale: "normal",
};
vi.mock("~/hooks/useSettings", () => ({
  useClientSetting: (key: string) => {
    useUiStateStore((s) => s.projectOrder);
    return key === "sidebarProjectSortOrder"
      ? mocks.manual
        ? "manual"
        : "recent"
      : settings[key as keyof typeof settings];
  },
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
// Real content, navigation order, list wrappers and project projection. Only transport/leaf UI is replaced.
vi.mock("./LastCodeSidebarProject", () => ({
  LastCodeSidebarProject: (props: ComponentProps<typeof LastCodeSidebarProject>) => {
    const rendering = useLastCodeProjectThreads(
      props.project,
      props.activeThreadKey,
      true,
      props.listExpanded,
    );
    return (
      <section data-project={props.project.projectKey}>
        <input aria-label={props.project.projectKey} defaultValue="original" />
        <button
          onClick={() => props.onListExpandedChange(props.project.projectKey, !props.listExpanded)}
        >
          {props.listExpanded ? "Show less" : "Show more"}
        </button>
        <output>{rendering.familyProjection.orderedThreadKeys.join(",")}</output>
        <span data-active>{props.activeThreadKey}</span>
      </section>
    );
  },
}));
vi.mock("./LastCodeSidebarSearch", () => ({ LastCodeSidebarSearch: () => null }));
vi.mock("./LastCodeSidebarProjectToolbar", () => ({ LastCodeSidebarProjectToolbar: () => null }));
vi.mock("./ProjectSidebarDraftList", () => ({
  ProjectSidebarDraftList: () => <input aria-label="unsent draft" defaultValue="draft" />,
}));
vi.mock("./LastCodeSidebarDesktopNotice", () => ({ LastCodeSidebarDesktopNotice: () => null }));
vi.mock("./LastCodeSidebarConnectionNotice", () => ({
  LastCodeSidebarConnectionNotice: () => null,
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => true }));
const environmentMetadata = {
  grouping: {},
  presentation: {
    projectEnvironments: {
      desktopLocalEnvironmentIds: new Set(),
      knownEnvironmentIds: new Set(),
      showLocalEnvironmentIcon: false,
    },
    providerEntriesByEnvironmentId: new Map(),
    environmentIconColors: {},
    providerBadgePreferences: { enabled: false, size: 50, transparency: 0 },
  },
};
vi.mock("./useLastCodeSidebarEnvironments", () => ({
  useLastCodeSidebarEnvironments: () => environmentMetadata,
}));
vi.mock("./useLastCodeSidebarRoute", () => ({
  useLastCodeSidebarRoute: () => ({
    routeThreadKey: fixture.route,
    routeThreadRef: null,
    terminalOpen: false,
  }),
}));
vi.mock("./useLastCodeSidebarShortcuts", () => ({
  useLastCodeSidebarShortcuts: (keys: readonly string[]) => {
    useEffect(() => {
      fixture.navigation = keys;
    }, [keys]);
    return {
      visibleThreadJumpLabelByKey: new Map(),
      newThreadShortcutLabel: null,
      commandPaletteShortcutLabel: null,
    };
  },
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.newThread }));
vi.mock("../../state/threads", () => ({
  useEnvironmentThread: (env: string, id: string) => {
    useEffect(() => {
      const key = `${env}:${id}`;
      fixture.prewarm.add(key);
      return () => {
        fixture.prewarm.delete(key);
      };
    }, [env, id]);
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShellsForProjectRefs: (
    refs: readonly { environmentId: EnvironmentId; projectId: ProjectId }[],
  ) =>
    threads.filter((t) =>
      refs.some((ref) => ref.environmentId === t.environmentId && ref.projectId === t.projectId),
    ),
}));
vi.mock("./useLastCodeSidebarProjects", () => ({
  useLastCodeSidebarProjects: () => {
    useUiStateStore((s) => s.projectOrder);
    return {
      sortedProjects: fixture.projects,
      orderedProjectKeys: orderedKeys,
      resolveProjectKey,
      index,
    };
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
const threads = defaultProjects.flatMap((p) =>
  [0, 1, 2].map((i) =>
    makeThreadFixture({
      environmentId: p.environmentId,
      projectId: p.id,
      id: ThreadId.make(`thread-${i}`),
      createdAt: `2026-01-0${3 - i}T00:00:00Z`,
    }),
  ),
);
const resolveProjectKey = (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
  defaultProjects.find((p) =>
    p.memberProjectRefs.some(
      (m) => m.environmentId === ref.environmentId && m.projectId === ref.projectId,
    ),
  )?.projectKey ?? "missing";
const index = indexLastCodeSidebarThreads(threads, resolveProjectKey);
const fixture = {
  projects: defaultProjects,
  route: null as string | null,
  navigation: [] as readonly string[],
  prewarm: new Set<string>(),
  newThread: async () => null,
};
async function render() {
  await act(() => root.render(<LastCodeSidebarContent />));
}
function section(key: string) {
  return container.querySelector<HTMLElement>(`[data-project="${key}"]`)!;
}
function renderedKeys() {
  return [...container.querySelectorAll("section output")].flatMap((o) =>
    o.textContent!.split(",").filter(Boolean),
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
  useUiStateStore.setState({
    projectOrder: [],
    projectExpandedById: {},
    threadLastVisitedAtById: {},
  });
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
  fixture.projects = defaultProjects;
  fixture.route = null;
  fixture.navigation = [];
  fixture.prewarm.clear();
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
describe("content-owned expansion and navigation", () => {
  it("uses one expansion owner for real rendered order and root navigation without exceeding three prewarms", async () => {
    await render();
    expect(renderedKeys()).toHaveLength(2);
    expect(fixture.navigation).toEqual(renderedKeys());
    expect(fixture.prewarm.size).toBe(2);
    await act(() => section("group").querySelector<HTMLButtonElement>("button")!.click());
    expect(renderedKeys()).toHaveLength(4);
    expect(fixture.navigation).toEqual(renderedKeys());
    expect(section("other").querySelector("output")!.textContent!.split(",")).toHaveLength(1);
    expect(fixture.prewarm.size).toBe(3);
    expect([...fixture.prewarm]).toEqual(fixture.navigation.slice(0, 3));
    await act(() => section("group").querySelector<HTMLButtonElement>("button")!.click());
    expect(renderedKeys()).toHaveLength(2);
    expect(fixture.navigation).toEqual(renderedKeys());
    expect(fixture.prewarm.size).toBe(2);
  });
  it("keeps expansion and the draft across real sort-mode remounts while project editor probes reset", async () => {
    await render();
    const editor = section("group").querySelector<HTMLInputElement>("input")!;
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="unsent draft"]')!;
    editor.value = "editing";
    draft.value = "unsent";
    await act(() => section("group").querySelector<HTMLButtonElement>("button")!.click());
    expect(section("group").querySelector("input")).toBe(editor);
    mocks.manual = false;
    // The mocked transport publishes a refresh; Content itself remains mounted with no props.
    await act(() => useUiStateStore.setState({ projectOrder: [] }));
    expect(section("group").querySelector("button")!.textContent).toBe("Show less");
    expect(section("group").querySelector("input")).not.toBe(editor);
    expect(container.querySelector('input[aria-label="unsent draft"]')).toBe(draft);
    expect(draft.value).toBe("unsent");
    expect(fixture.navigation).toEqual(renderedKeys());
    expect(renderedKeys()).toHaveLength(4);
  });
  it("retains expansion through scoped route and collection refreshes", async () => {
    await render();
    await act(() => section("group").querySelector<HTMLButtonElement>("button")!.click());
    const target = threads[4]!;
    fixture.route = scopedThreadKey(scopeThreadRef(target.environmentId, target.id));
    fixture.projects = [other, grouped];
    await act(() => useUiStateStore.setState({ projectOrder: [] }));
    expect(section("other").querySelector("[data-active]")!.textContent).toBe(fixture.route);
    expect(section("group").querySelector("[data-active]")!.textContent).toBe("");
    expect(section("group").querySelector("button")!.textContent).toBe("Show less");
    expect(fixture.navigation).toEqual(renderedKeys());
    await act(() => root.unmount());
    expect(fixture.prewarm.size).toBe(0);
    root = createRoot(container);
  });
});
