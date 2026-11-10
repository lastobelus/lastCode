import { act, render, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import {
  lastcodeSidebarThreadKey,
  lastcodeSidebarSubagentGroupKey,
  projectLastCodeSidebarFamilies,
} from "../lastcodeSidebarFamilies.logic";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { LastCodeThreadFamilyDisclosure, LastCodeSubagentGroup } from "./LastCodeThreadFamily";
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  row: vi.fn(),
  creator: null as ReturnType<typeof makeThreadFixture> | null,
  readCreator: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSetting: (key: string) =>
    (
      {
        lastcodeStatusIcons: {},
        compactLegacySidebarStatuses: false,
        lastcodeSidebarFamilyStatusSubheaders: true,
        legacySidebarThreadGroupingStyle: "typed-groups",
      } as Record<string, unknown>
    )[key],
}));
vi.mock("../ThreadStatusIndicators", () => ({ ThreadStatusLabel: () => null }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: unknown) => {
    mocks.readCreator(ref);
    return mocks.creator;
  },
}));
import { useLastCodeThreadFamily } from "./useLastCodeThreadFamily";
const parent = makeThreadFixture({
  id: ThreadId.make("parent"),
  environmentId: EnvironmentId.make("first"),
  title: "Parent",
});
const child = makeThreadFixture({
  id: ThreadId.make("child"),
  environmentId: parent.environmentId,
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const interactive = makeThreadFixture({
  ...child,
  lineage: { rootThreadId: child.id, parentThreadId: null, relationshipToParent: null },
  creatorThreadId: parent.id,
  creatorGrouping: "grouped",
  source: { ...child.source, createdBy: "agent" },
});
function projection(
  active = false,
  collapsed = false,
  style: "typed-groups" | "minimal" = "typed-groups",
) {
  return projectLastCodeSidebarFamilies({
    threads: [parent, style === "minimal" ? interactive : child],
    collapsedByKey: {
      [lastcodeSidebarThreadKey(parent)]: collapsed,
      [lastcodeSidebarSubagentGroupKey(lastcodeSidebarThreadKey(parent))]: collapsed,
    },
    activeThreadKey: active ? lastcodeSidebarThreadKey(child) : null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    groupingStyle: style,
    statusForThread: () => null,
  });
}

async function disclosure(
  screen: Screen,
  active: boolean,
  collapsed = false,
  style: "typed-groups" | "minimal" = "typed-groups",
) {
  const family = projection(active, collapsed, style).renderedRows.find(
    (row) => row.thread.id === parent.id,
  )!;
  await act(() =>
    screen.rerender(
      <div onClick={mocks.row} onKeyDown={mocks.row} onDoubleClick={mocks.row}>
        <LastCodeThreadFamilyDisclosure
          family={family}
          renameTarget={false}
          navigateToThread={mocks.navigate}
        />
      </div>,
    ),
  );
  return screen.container.querySelector("button")!;
}
describe("family disclosure ownership", () => {
  it("persists an exact scoped family key and returns to the parent when collapsing its selected child", async () => {
    setup();
    await using screen = await render(null);

    const button = await disclosure(screen, true);
    await act(() => button.click());
    expect(mocks.navigate).toHaveBeenCalledWith(scopeThreadRef(parent.environmentId, parent.id));
    expect(mocks.row).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("lastcode:legacy-sidebar-collapsed-families:v1")!),
    ).toEqual({ [lastcodeSidebarThreadKey(parent)]: true });
    expect(
      useLastCodeSidebarFamiliesStore.getState().collapsedByKey[
        lastcodeSidebarThreadKey({ ...parent, environmentId: EnvironmentId.make("second") })
      ],
    ).toBeUndefined();
  });
  it("expands without navigation and isolates nested keyboard/double-click activation", async () => {
    setup();
    await using screen = await render(null);

    const button = await disclosure(screen, false, true);
    await act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      button.click();
    });
    expect(mocks.row).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(
      useLastCodeSidebarFamiliesStore.getState().collapsedByKey[lastcodeSidebarThreadKey(parent)],
    ).toBe(false);
  });
  it("keeps an interactive created conversation selected when its family collapses", async () => {
    setup();
    await using screen = await render(null);

    const button = await disclosure(screen, true, false, "minimal");
    await act(() => button.click());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(
      useLastCodeSidebarFamiliesStore.getState().collapsedByKey[lastcodeSidebarThreadKey(parent)],
    ).toBe(true);
  });
  it("persists the distinct subagent-group key and follows its projected parent navigation", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    const item = projection(true).renderedItems.find((item) => item.type === "subagents");
    expect(item?.type).toBe("subagents");
    if (item?.type !== "subagents") throw new Error("Missing projected group");
    await act(() =>
      screen.rerender(
        <ul>
          <LastCodeSubagentGroup item={item} navigateToThread={mocks.navigate} />
        </ul>,
      ),
    );
    await act(() => container.querySelector("button")!.click());
    expect(mocks.navigate).toHaveBeenCalledWith(scopeThreadRef(parent.environmentId, parent.id));
    expect(useLastCodeSidebarFamiliesStore.getState().collapsedByKey).toEqual({ [item.key]: true });
  });
});

function CreatorPresentation({ foreign = false }: { foreign?: boolean }) {
  const thread = foreign
    ? { ...interactive, environmentId: EnvironmentId.make("second") }
    : interactive;
  const family = projectLastCodeSidebarFamilies({
    threads: [thread],
    collapsedByKey: {},
    activeThreadKey: null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    groupingStyle: "typed-groups",
    statusForThread: () => null,
  }).renderedRows[0]!;
  const value = useLastCodeThreadFamily(family, null);
  return (
    <output>
      {value.relationshipDescription}|{value.relationshipUnavailableLabel}
    </output>
  );
}
describe("creator presentation targeting", () => {
  it("reads the creator once in the owning environment and updates its description on refresh", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    mocks.creator = parent;
    await act(() => screen.rerender(<CreatorPresentation />));
    expect(mocks.readCreator).toHaveBeenCalledExactlyOnceWith(
      scopeThreadRef(parent.environmentId, parent.id),
    );
    expect(container.textContent).toContain("Parent");
    mocks.creator = { ...parent, title: "Renamed creator" };
    await act(() => screen.rerender(<CreatorPresentation />));
    expect(container.textContent).toContain("Renamed creator");
  });
  it("rejects a same-ID creator from another environment", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    mocks.creator = parent;
    await act(() => screen.rerender(<CreatorPresentation foreign />));
    expect(mocks.readCreator).toHaveBeenCalledExactlyOnceWith(
      scopeThreadRef(EnvironmentId.make("second"), parent.id),
    );
    expect(container.textContent).not.toContain("Parent");
    expect(container.textContent).toContain("unavailable");
  });
});

function setup() {
  vi.clearAllMocks();
  mocks.creator = null;
  localStorage.clear();
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
}
