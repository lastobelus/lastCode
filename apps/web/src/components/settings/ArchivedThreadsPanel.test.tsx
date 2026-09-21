import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scope: null as unknown as {
    kind: "all" | "environment" | "project" | "checkout";
    environmentIds: EnvironmentId[];
    members: Array<{ id: string; environmentId: EnvironmentId }>;
  },
  scopeReady: true,
  connectedEnvironmentIds: [] as EnvironmentId[],
  archive: {
    snapshots: [] as Array<{
      environmentId: EnvironmentId;
      snapshot: {
        projects: Array<{ id: string; title: string }>;
        threads: Array<{
          id: string;
          projectId: string;
          title: string;
          createdAt: string;
          archivedAt: string;
        }>;
      };
    }>,
    error: null as string | null,
    isLoading: false,
    refresh: vi.fn(),
  },
  requestedEnvironmentIds: [] as EnvironmentId[],
  contextMenu: vi.fn(),
  unarchiveThread: vi.fn(),
  confirmAndDeleteThread: vi.fn(),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: state.scope,
    isReady: state.scopeReady,
    connectedEnvironments: state.connectedEnvironmentIds.map((environmentId) => ({
      environmentId,
    })),
  }),
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: (environmentIds: EnvironmentId[]) => {
    state.requestedEnvironmentIds = environmentIds;
    return {
      ...state.archive,
      snapshots: state.archive.snapshots.filter((entry) =>
        environmentIds.includes(entry.environmentId),
      ),
    };
  },
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: state.unarchiveThread,
    confirmAndDeleteThread: state.confirmAndDeleteThread,
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: vi.fn(),
  readLocalApi: () => ({ contextMenu: { show: state.contextMenu } }),
}));

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: () => null,
}));

vi.mock("./settingsLayout", () => ({
  PolicyTooltip: ({ children }: { children: ReactNode }) => children,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: () => null,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="settings-page">{children}</div>
  ),
  SettingsSection: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <section data-title={title}>{children}</section>
  ),
  SettingsRow: ({ title, description, control, onContextMenu }: Record<string, unknown>) => (
    <div data-testid="settings-row" onContextMenu={onContextMenu as () => void}>
      <div data-testid="row-title">{title as ReactNode}</div>
      <div data-testid="row-description">{description as ReactNode}</div>
      {control as ReactNode}
    </div>
  ),
  useSettingsSearchTarget: () => vi.fn(),
  useSettingsSearchTargetId: () => null,
}));

import { ArchivedThreadsPanel } from "./SettingsPanels";

const envA = "environment-a" as EnvironmentId;
const envB = "environment-b" as EnvironmentId;
const renderers: ReactTestRenderer[] = [];

function snapshot(
  environmentId: EnvironmentId,
  projects: Array<{ id: string; title: string }>,
  threads: Array<{ id: string; projectId: string; title: string }>,
) {
  return {
    environmentId,
    snapshot: {
      projects,
      threads: threads.map((thread, index) => ({
        ...thread,
        createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        archivedAt: `2026-09-1${index + 1}T00:00:00.000Z`,
      })),
    },
  };
}

function renderPanel(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ArchivedThreadsPanel />);
  });
  renderers.push(renderer);
  return renderer;
}

function text(renderer: ReactTestRenderer): string {
  const collect = (node: string | { children: Array<unknown> }): string =>
    typeof node === "string"
      ? node
      : node.children
          .filter(
            (child): child is string | { children: Array<unknown> } =>
              typeof child === "string" ||
              (typeof child === "object" && child !== null && "children" in child),
          )
          .map(collect)
          .join(" ");
  return renderer.root
    .findAll((node) => node.props["data-testid"] === "row-title")
    .map(collect)
    .join(" ");
}

describe("ArchivedThreadsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.scope = { kind: "all", environmentIds: [envA, envB], members: [] };
    state.scopeReady = true;
    state.connectedEnvironmentIds = [envA, envB];
    state.archive.snapshots = [
      snapshot(
        envA,
        [
          { id: "project-a", title: "Alpha" },
          { id: "project-hidden", title: "Hidden checkout" },
        ],
        [
          { id: "thread-a", projectId: "project-a", title: "Alpha thread" },
          { id: "thread-hidden", projectId: "project-hidden", title: "Hidden thread" },
        ],
      ),
      snapshot(
        envB,
        [{ id: "project-b", title: "Beta" }],
        [{ id: "thread-b", projectId: "project-b", title: "Beta thread" }],
      ),
    ];
    state.archive.error = null;
    state.archive.isLoading = false;
    state.archive.refresh.mockReset();
    state.contextMenu.mockReset();
    state.unarchiveThread.mockReset();
    state.confirmAndDeleteThread.mockReset();
    state.requestedEnvironmentIds = [];
  });

  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) renderer.unmount();
    });
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "all environments",
      scope: { kind: "all" as const, environmentIds: [envA, envB], members: [] },
      shown: ["Alpha thread", "Hidden thread", "Beta thread"],
      hidden: [],
    },
    {
      name: "one environment",
      scope: { kind: "environment" as const, environmentIds: [envA], members: [] },
      shown: ["Alpha thread", "Hidden thread"],
      hidden: ["Beta thread"],
    },
    {
      name: "a project across environments",
      scope: {
        kind: "project" as const,
        environmentIds: [envA, envB],
        members: [
          { id: "project-a", environmentId: envA },
          { id: "project-b", environmentId: envB },
        ],
      },
      shown: ["Alpha thread", "Beta thread"],
      hidden: ["Hidden thread"],
    },
    {
      name: "one checkout",
      scope: {
        kind: "checkout" as const,
        environmentIds: [envB],
        members: [{ id: "project-b", environmentId: envB }],
      },
      shown: ["Beta thread"],
      hidden: ["Alpha thread", "Hidden thread"],
    },
  ])("shows archived threads for $name", ({ scope, shown, hidden }) => {
    state.scope = scope;
    state.connectedEnvironmentIds = scope.environmentIds;
    const renderer = renderPanel();
    const renderedText = text(renderer);

    expect(state.requestedEnvironmentIds).toEqual(scope.environmentIds);
    for (const title of shown) expect(renderedText).toContain(title);
    for (const title of hidden) expect(renderedText).not.toContain(title);
  });

  it("keeps matching project IDs in different environments separate and sorts newest first", () => {
    state.archive.snapshots = [
      snapshot(
        envA,
        [{ id: "shared-id", title: "Alpha" }],
        [
          { id: "older", projectId: "shared-id", title: "Older Alpha" },
          { id: "newer", projectId: "shared-id", title: "Newer Alpha" },
        ],
      ),
      snapshot(
        envB,
        [{ id: "shared-id", title: "Beta" }],
        [{ id: "beta", projectId: "shared-id", title: "Beta thread" }],
      ),
    ];

    const renderer = renderPanel();
    const sections = renderer.root.findAllByType("section");
    expect(sections).toHaveLength(2);
    expect(
      sections.map((section) =>
        section
          .findAll((node) => node.props["data-testid"] === "row-title")
          .map((node) => node.children.join("")),
      ),
    ).toEqual([["Newer Alpha", "Older Alpha"], ["Beta thread"]]);
  });

  it("queries only connected environments while preserving the selected scope", () => {
    state.scope = {
      kind: "project",
      environmentIds: [envA, envB],
      members: [
        { id: "project-a", environmentId: envA },
        { id: "project-b", environmentId: envB },
      ],
    };
    state.connectedEnvironmentIds = [envA];

    const renderedText = text(renderPanel());

    expect(state.requestedEnvironmentIds).toEqual([envA]);
    expect(renderedText).toContain("Alpha thread");
    expect(renderedText).not.toContain("Beta thread");
  });

  it("waits for scope discovery before showing an empty archive", () => {
    state.scopeReady = false;
    state.connectedEnvironmentIds = [];
    state.archive.snapshots = [];
    const renderer = renderPanel();
    expect(text(renderer)).toContain("Loading archived threads");
    expect(text(renderer)).not.toContain("No archived threads");

    state.scopeReady = true;
    act(() => renderer.update(<ArchivedThreadsPanel />));
    expect(text(renderer)).toContain("No archived threads");
    expect(text(renderer)).not.toContain("Loading archived threads");
  });

  it.each([
    [true, null, "Loading archived threads", "Checking connected environments."],
    [
      false,
      "Archive service unavailable",
      "Could not load archived threads",
      "Archive service unavailable",
    ],
    [false, null, "No archived threads", "Archived threads will appear here."],
  ] as const)("renders empty state loading=%s error=%s", (isLoading, error, title, description) => {
    state.archive.snapshots = [];
    state.archive.isLoading = isLoading;
    state.archive.error = error;
    const renderer = renderPanel();

    expect(text(renderer)).toContain(title);
    expect(
      renderer.root.find((node) => node.props["data-testid"] === "row-description").children,
    ).toContain(description);
  });

  it("deletes with the complete environment snapshot even when project scope hides a checkout", async () => {
    state.scope = {
      kind: "project",
      environmentIds: [envA],
      members: [{ id: "project-a", environmentId: envA }],
    };
    state.contextMenu.mockResolvedValue("delete");
    let markDeleteInvoked!: () => void;
    const deleteInvoked = new Promise<void>((resolve) => {
      markDeleteInvoked = resolve;
    });
    state.confirmAndDeleteThread.mockImplementation(() => {
      markDeleteInvoked();
      return Promise.resolve(AsyncResult.success(undefined));
    });
    const renderer = renderPanel();
    const visibleRow = renderer.root
      .findAll((node) => node.props["data-testid"] === "settings-row")
      .find((row) =>
        row
          .find((node) => node.props["data-testid"] === "row-title")
          .children.includes("Alpha thread"),
      );

    await act(async () => {
      visibleRow?.props.onContextMenu({
        preventDefault: vi.fn(),
        clientX: 10,
        clientY: 20,
      });
      await deleteInvoked;
    });

    expect(state.confirmAndDeleteThread).toHaveBeenCalledWith(
      { environmentId: envA, threadId: "thread-a" },
      {
        archivedThreads: expect.arrayContaining([
          expect.objectContaining({ id: "thread-a", environmentId: envA }),
          expect.objectContaining({ id: "thread-hidden", environmentId: envA }),
        ]),
      },
    );
    expect(state.confirmAndDeleteThread.mock.calls[0]?.[1].archivedThreads).toHaveLength(2);
  });
});
