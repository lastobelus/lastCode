// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { projectLastCodeSidebarFamilies } from "../lastcodeSidebarFamilies.logic";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { LastCodeThreadFamilyDisclosure } from "./LastCodeThreadFamily";
import { LastCodeThreadList } from "./LastCodeThreadList";
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  expansion: vi.fn(),
  attach: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSetting: (key: string) =>
    key === "legacySidebarThreadGroupingStyle" ? "typed-groups" : false,
}));
vi.mock("../ThreadStatusIndicators", () => ({ ThreadStatusLabel: () => null }));
const parent = makeThreadFixture({
  id: ThreadId.make("parent"),
  environmentId: EnvironmentId.make("first"),
  title: "Parent",
});
const child = makeThreadFixture({
  ...parent,
  id: ThreadId.make("child"),
  title: "Child",
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const other = makeThreadFixture({ ...parent, id: ThreadId.make("other"), title: "Other" });
function Harness({
  selectedChild = false,
  projectExpanded = true,
  empty = false,
}: {
  selectedChild?: boolean;
  projectExpanded?: boolean;
  empty?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsedByKey = useLastCodeSidebarFamiliesStore((s) => s.collapsedByKey);
  const familyProjection = projectLastCodeSidebarFamilies({
    threads: empty ? [] : [parent, child, other],
    collapsedByKey,
    activeThreadKey: selectedChild
      ? scopedThreadKey(scopeThreadRef(child.environmentId, child.id))
      : null,
    projectExpanded,
    previewCount: 1,
    listExpanded: expanded,
    groupingStyle: "typed-groups",
    statusForThread: () => null,
  });
  return (
    <LastCodeThreadList
      scale={100}
      projection={{ familyProjection, hiddenThreadStatus: null }}
      projectExpanded={projectExpanded}
      listExpanded={expanded}
      onListExpandedChange={(value) => {
        mocks.expansion(value);
        setExpanded(value);
      }}
      attachAnimation={mocks.attach}
      navigateToThread={mocks.navigate}
      renderRow={(family) => (
        <li>
          <LastCodeThreadFamilyDisclosure
            family={family}
            renameTarget={false}
            navigateToThread={mocks.navigate}
          />
          <span>{family.thread.title}</span>
          <input aria-label={`Draft ${family.thread.title}`} defaultValue="retained" />
        </li>
      )}
    />
  );
}
let root: Root | null = null,
  container: HTMLDivElement;
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
  useLastCodeSidebarFamiliesStore.setState({
    collapsedByKey: { [scopedThreadKey(scopeThreadRef(parent.environmentId, parent.id))]: false },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root?.unmount());
  container.remove();
  root = null;
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
const named = (name: string) =>
  [...container.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith(name),
  )!;
describe("project thread list composition", () => {
  it("changes preview expansion in its owner without remounting the retained family row", async () => {
    await act(() => root?.render(<Harness />));
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft Parent"]')!;
    draft.value = "in progress";
    expect(container.textContent).not.toContain("Other");
    await act(() => button("Show more").click());
    expect(container.textContent).toContain("Other");
    expect(container.querySelector('input[aria-label="Draft Parent"]')).toBe(draft);
    expect(draft.value).toBe("in progress");
    await act(() => button("Show less").click());
    expect(container.textContent).not.toContain("Other");
    expect(container.querySelector('input[aria-label="Draft Parent"]')).toBe(draft);
    expect(mocks.expansion.mock.calls).toEqual([[true], [false]]);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });
  it("uses the real typed subagent disclosure and returns a selected child to its parent", async () => {
    await act(() => root?.render(<Harness selectedChild />));
    await act(() => named("Collapse subagents and return to Parent").click());
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      scopeThreadRef(parent.environmentId, parent.id),
    );
    // The selected path stays visible until the owner's route reaches the parent.
    expect(container.textContent).toContain("Child");
    await act(() => root?.render(<Harness />));
    expect(container.textContent).not.toContain("Child");
    expect(named("Expand subagents of Parent")).toBeDefined();
    await act(() => named("Expand subagents of Parent").click());
    expect(container.textContent).toContain("Child");
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps a selected family visible under a collapsed project without showing expansion controls", async () => {
    await act(() => root?.render(<Harness selectedChild projectExpanded={false} />));
    expect(container.textContent).toContain("Parent");
    expect(container.textContent).toContain("Child");
    expect(button("Show more")).toBeUndefined();
    expect(button("Show less")).toBeUndefined();
  });
  it("shows an empty project only while expanded", async () => {
    await act(() => root?.render(<Harness empty />));
    expect(container.textContent).toBe("No threads yet");
    await act(() => root?.render(<Harness empty projectExpanded={false} />));
    expect(container.textContent).toBe("");
  });
});
