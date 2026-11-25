import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { Project } from "../../types";
import { makeThreadFixture } from "../../test-fixtures";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { useLastCodeProjectThreads } from "./useLastCodeProjectThreads";
import { useLastCodeSidebarOrder } from "./useLastCodeSidebarOrder";
import { lastcodeSidebarSubagentGroupKey } from "../lastcodeSidebarFamilies.logic";
const settings = vi.hoisted(() => ({
  lastcodeSidebarFamilyStatusSubheaders: true,
  sidebarThreadSortOrder: "created_at" as const,
  sidebarThreadPreviewCount: 1 as const,
  legacySidebarThreadGroupingStyle: "typed-groups" as "minimal" | "typed-groups",
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: keyof typeof settings) => settings[key],
}));
const first = EnvironmentId.make("first"),
  second = EnvironmentId.make("second");
const parent = makeThreadFixture({
  environmentId: first,
  id: ThreadId.make("parent"),
  createdAt: "2026-01-03T00:00:00Z",
});
const child = makeThreadFixture({
  ...parent,
  id: ThreadId.make("child"),
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const other = makeThreadFixture({
  environmentId: second,
  id: parent.id,
  projectId: parent.projectId,
  createdAt: "2026-01-02T00:00:00Z",
});
const threads = [parent, child, other];
vi.mock("../../state/entities", () => ({ useThreadShellsForProjectRefs: () => threads }));
const projects: Project[] = [first, second].map((environmentId) => ({
  environmentId,
  id: ProjectId.make(parent.projectId),
  title: "Project",
  workspaceRoot: `/work/${environmentId}`,
  repositoryIdentity: {
    canonicalKey: "github.com/example/project",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/project.git",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}));
const groups = buildSidebarProjectSnapshots({
  projects,
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: first,
  resolveEnvironmentLabel: (id) => id,
});
const group = groups[0]!,
  byProject = new Map([[group.projectKey, threads]]);
const key = (thread: typeof parent) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
function Harness({
  expanded,
  list,
  active,
}: {
  expanded: boolean;
  list: boolean;
  active: string | null;
}) {
  const rendering = useLastCodeProjectThreads(group, active, expanded, list);
  const navigation = useLastCodeSidebarOrder(
    groups,
    byProject,
    active,
    new Set(list ? [group.projectKey] : []),
  );
  return (
    <>
      <output data-testid="navigation">{navigation.join(",")}</output>
      <output data-testid="rendering">
        {rendering.familyProjection.orderedThreadKeys.join(",")}
      </output>
      <input defaultValue="original" />
    </>
  );
}
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  useUiStateStore.setState({ projectExpandedById: {}, threadLastVisitedAtById: {} });
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useUiStateStore.setState({ projectExpandedById: {}, threadLastVisitedAtById: {} });
  useLastCodeSidebarFamiliesStore.setState({ collapsedByKey: {} });
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
describe("actual root and project order parity", () => {
  it("matches both subheader modes with independent parent and group collapse inputs on one retained mount", async () => {
    let input: HTMLInputElement | undefined;
    for (const subheaders of [true, false])
      for (const grouping of ["minimal", "typed-groups"] as const)
        for (const expanded of [false, true])
          for (const list of [false, true])
            for (const active of [null, key(child)])
              for (const collapsed of [false, true]) {
                for (const groupCollapsed of [undefined, false, true]) {
                  settings.lastcodeSidebarFamilyStatusSubheaders = subheaders;
                  settings.legacySidebarThreadGroupingStyle = grouping;
                  await act(() => {
                    useUiStateStore.getState().setProjectExpanded([group.projectKey], expanded);
                    useLastCodeSidebarFamiliesStore.setState({
                      collapsedByKey: {
                        [key(parent)]: collapsed,
                        ...(groupCollapsed === undefined
                          ? {}
                          : { [lastcodeSidebarSubagentGroupKey(key(parent))]: groupCollapsed }),
                      },
                    });
                    root.render(<Harness expanded={expanded} list={list} active={active} />);
                  });
                  expect(container.querySelector('[data-testid="navigation"]')!.textContent).toBe(
                    container.querySelector('[data-testid="rendering"]')!.textContent,
                  );
                  if (expanded && !collapsed && active === null) {
                    const actual = container
                      .querySelector('[data-testid="navigation"]')!
                      .textContent!.split(",");
                    expect(actual.includes(key(child))).toBe(
                      !subheaders || groupCollapsed === false,
                    );
                  }
                  const current = container.querySelector("input")!;
                  if (input) {
                    expect(current).toBe(input);
                    expect(current.value).toBe("retained draft");
                  } else {
                    input = current;
                    input.value = "retained draft";
                  }
                }
              }
  });
});
