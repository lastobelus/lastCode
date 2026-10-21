import { act, useEffect } from "react";
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
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeThreadRef,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { lastcodeSidebarSubagentGroupKey } from "../lastcodeSidebarFamilies.logic";
import { useLastCodeProjectThreads } from "./useLastCodeProjectThreads";
import {
  projectLastCodeProjectThreads,
  lastCodeProjectThreadStatus,
} from "./lastcodeProjectThreads";
const settings = vi.hoisted(() => ({
  sidebarThreadSortOrder: "created_at" as const,
  sidebarThreadPreviewCount: 1 as const,
  legacySidebarThreadGroupingStyle: "typed-groups" as "typed-groups" | "minimal",
}));
const parent = makeThreadFixture({
  id: ThreadId.make("parent"),
  title: "Parent",
  createdAt: "2026-01-03T00:00:00.000Z",
});
const child = makeThreadFixture({
  id: ThreadId.make("child"),
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const other = makeThreadFixture({
  id: ThreadId.make("other"),
  environmentId: EnvironmentId.make("other-environment"),
  createdAt: "2026-01-02T00:00:00.000Z",
});
const archived = makeThreadFixture({
  id: ThreadId.make("archived"),
  archivedAt: "2026-01-02T00:00:00.000Z",
});
const threads = [parent, child, other, archived];
vi.mock("../../state/entities", () => ({ useThreadShellsForProjectRefs: () => threads }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: keyof typeof settings) => settings[key],
}));
const key = (thread: typeof parent) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const project = {
  memberProjectRefs: [
    scopeProjectRef(parent.environmentId, parent.projectId),
    scopeProjectRef(other.environmentId, other.projectId),
  ],
};
const observe = vi.fn<(value: ReturnType<typeof useLastCodeProjectThreads>) => void>();
function Harness({
  expanded = true,
  list = false,
  active = null,
}: {
  expanded?: boolean;
  list?: boolean;
  active?: string | null;
}) {
  const value = useLastCodeProjectThreads(project, active, expanded, list);
  useEffect(() => observe(value), [value]);
  return <output>{value.familyProjection.orderedThreadKeys.join(",")}</output>;
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
  settings.legacySidebarThreadGroupingStyle = "typed-groups";
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  observe.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
const latest = () => observe.mock.calls.at(-1)![0];
describe("project-local thread projection", () => {
  it("preserves sorted tie precedence and reports status from hidden visible roots", () => {
    const result = projectLastCodeProjectThreads([other, parent, archived], "created_at", {
      collapsedByKey: {},
      activeThreadKey: null,
      projectExpanded: true,
      previewCount: 1,
      listExpanded: false,
      groupingStyle: "minimal",
      statusForThread: (thread) => ({
        label: "Completed",
        description: thread.title,
        colorClass: "",
        dotClass: "",
        pulse: false,
      }),
    });
    expect(result.projectStatus?.description).toBe("Parent");
    expect(result.hiddenThreadStatus?.description).toBe(other.title);
    expect(result.familyProjection.hiddenThreads.map((thread) => thread.id)).toEqual([other.id]);
  });
  it("preserves rendering/navigation parity for every expansion, grouping and selected-path input", async () => {
    for (const grouping of ["minimal", "typed-groups"] as const) {
      settings.legacySidebarThreadGroupingStyle = grouping;
      for (const expanded of [false, true])
        for (const list of [false, true])
          for (const active of [null, key(child)]) {
            await act(() =>
              root.render(<Harness expanded={expanded} list={list} active={active} />),
            );
            const rendering = latest();
            const { familyProjection: navigation } = projectLastCodeProjectThreads(
              threads,
              settings.sidebarThreadSortOrder,
              {
                collapsedByKey: {},
                activeThreadKey: active,
                projectExpanded: expanded,
                previewCount: settings.sidebarThreadPreviewCount,
                listExpanded: list,
                groupingStyle: grouping,
              },
            );
            expect(rendering.familyProjection.orderedThreadKeys).toEqual(
              navigation.orderedThreadKeys,
            );
            expect(rendering.familyProjection.orderedThreadKeys).toEqual(
              rendering.familyProjection.renderedRows.map((row) => row.key),
            );
            expect(navigation.orderedThreadKeys).not.toContain(key(archived));
            expect(rendering.threadsByKey.get(key(archived))).toBe(archived);
          }
    }
  });
  it("ignores foreign collapse/visit updates and reacts to its own family and subagent keys", async () => {
    await act(() => root.render(<Harness list />));
    const count = observe.mock.calls.length;
    await act(() => {
      useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: { foreign: false } });
      useUiStateStore.getState().markThreadVisited("foreign", "2026-01-04T00:00:00.000Z");
    });
    expect(observe).toHaveBeenCalledTimes(count);
    await act(() =>
      useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: { [key(parent)]: false } }),
    );
    expect(latest().familyProjection.renderedItems.some((item) => item.type === "subagents")).toBe(
      true,
    );
    expect(latest().familyProjection.orderedThreadKeys).not.toContain(key(child));
    await act(() =>
      useLastCodeSidebarFamiliesStore.setState({
        collapsedByKey: {
          [key(parent)]: false,
          [lastcodeSidebarSubagentGroupKey(key(parent))]: false,
        },
      }),
    );
    expect(latest().familyProjection.orderedThreadKeys).toContain(key(child));
    await act(() =>
      useUiStateStore.getState().markThreadVisited(key(parent), "2026-01-04T00:00:00.000Z"),
    );
    expect(observe.mock.calls.length).toBeGreaterThan(count + 2);
  });
  it("keeps visit watermarks scoped when thread IDs collide across environments", () => {
    const completed = {
      ...parent,
      lastVisitedAt: "2026-01-02T00:00:00.000Z",
      latestRun: {
        runId: RunId.make("completed-run"),
        status: "completed" as const,
        assistantMessageId: null,
        requestedAt: "2026-01-02T00:00:00.000Z",
        startedAt: "2026-01-02T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      },
    };
    const foreign = {
      ...completed,
      environmentId: other.environmentId,
      lastVisitedAt: "2026-01-04T00:00:00.000Z",
    };
    const resolve = lastCodeProjectThreadStatus(
      [completed, foreign],
      ["2026-01-05T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    // A newer local visit must not mask the server's explicit unread rewind.
    expect(resolve(completed)).toMatchObject({ label: "Completed" });
    expect(resolve(foreign)).toBeNull();
  });
});
