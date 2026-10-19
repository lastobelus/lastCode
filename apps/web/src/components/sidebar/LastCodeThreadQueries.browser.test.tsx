import { LastCodeSidebarPresentationProvider } from "./LastCodeSidebarPresentation";
import { act, useEffect } from "react";
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
import {
  AuthPreviewOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import {
  useLastCodeThreadSourceControl,
  type LastCodeThreadSourceControlSnapshot,
} from "./useLastCodeThreadSourceControl";
import {
  useLastCodeThreadProcesses,
  type LastCodeThreadProcessSnapshot,
} from "./useLastCodeThreadProcesses";
import { LastCodeThreadSourceControl } from "./LastCodeThreadSourceControl";
import { LastCodeThreadProcesses } from "./LastCodeThreadProcesses";
const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  query: vi.fn(),
  status: vi.fn(),
  linked: vi.fn(),
  prPresentation: vi.fn(),
  terminalPresentation: vi.fn(),
  multi: vi.fn(),
  terminals: vi.fn(),
  previews: vi.fn(),
  supportsProcesses: vi.fn(),
  ports: vi.fn(),
  previewCommand: vi.fn(),
  openPort: vi.fn(),
  navigation: vi.fn(),
  openPr: vi.fn(),
  toast: vi.fn(),
  bubble: vi.fn(),
  previewPermission: true,
  readScope: vi.fn(),
  useScope: vi.fn(),
  scopeListeners: new Set<() => void>(),
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => mocks.openPr }));
vi.mock("../../state/entities", () => ({ useProject: mocks.project }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: mocks.status } }));
vi.mock("../../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: mocks.multi,
}));
vi.mock("../ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: mocks.linked,
  prStatusIndicator: mocks.prPresentation,
  terminalStatusFromRunningIds: mocks.terminalPresentation,
  ChangeRequestStatusIcon: () => null,
  PrStatusTooltipContent: () => null,
  synchronizeTerminalPulse: () => {},
}));
vi.mock("../../state/terminalSessions", () => ({ useThreadRunningTerminalIds: mocks.terminals }));
vi.mock("../../state/previewHosting", () => ({
  useThreadPreviewLeases: mocks.previews,
  usePreviewProcessControlsSupported: mocks.supportsProcesses,
}));
vi.mock("../../portDiscoveryState", () => ({ useThreadDiscoveredPorts: mocks.ports }));
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentScope: (...args: unknown[]) => {
      mocks.useScope(...args);
      return useSyncExternalStore(
        (listener) => {
          mocks.scopeListeners.add(listener);
          return () => {
            mocks.scopeListeners.delete(listener);
          };
        },
        () => mocks.previewPermission,
      );
    },
    readEnvironmentScope: mocks.readScope,
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.previewCommand }));
vi.mock("../../state/preview", () => ({ previewEnvironment: { open: "open" } }));
vi.mock("../preview/openDiscoveredPort", () => ({ openDiscoveredPort: mocks.openPort }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const thread = makeThreadFixture({
  environmentId: EnvironmentId.make("own-environment"),
  projectId: ProjectId.make("own-project"),
  id: ThreadId.make("same-id"),
  branch: "feature",
  worktreePath: null,
});
const ref = scopeThreadRef(thread.environmentId, thread.id);
const link = {
  host: "github.com",
  repository: "example/project",
  number: 17,
  url: "https://github.com/example/project/pull/17",
  source: "manual" as const,
  linkedAt: "2026-01-01T00:00:00Z",
  snapshot: null,
  stack: null,
};
const port: DiscoveredLocalServer = {
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: "node",
  pid: 12345,
  terminal: null,
};
let source: LastCodeThreadSourceControlSnapshot, processes: LastCodeThreadProcessSnapshot;
function Harness({
  value = thread,
  live = true,
  active = false,
  panel = true,
  fallback = "/representative-project",
}: {
  value?: SidebarThreadSummary;
  live?: boolean;
  active?: boolean;
  panel?: boolean;
  fallback?: string | null;
}) {
  const querySource = useLastCodeThreadSourceControl(value, live, fallback);
  const target = scopeThreadRef(value.environmentId, value.id);
  const queryProcesses = useLastCodeThreadProcesses(target);
  useEffect(() => {
    source = querySource;
    processes = queryProcesses;
  }, [querySource, queryProcesses]);
  return (
    <LastCodeSidebarPresentationProvider
      projectEnvironments={{
        desktopLocalEnvironmentIds: new Set(),
        knownEnvironmentIds: new Set(),
        showLocalEnvironmentIcon: false,
      }}
      providerEntriesByEnvironmentId={new Map()}
      environmentIconColors={{}}
      providerBadgePreferences={{ enabled: false, size: 50, transparency: 0 }}
      openPullRequestsInRightPanel={panel}
    >
      <div onClick={mocks.bubble}>
        <LastCodeThreadSourceControl
          thread={value}
          sourceControl={querySource}
          isActive={active}
          navigateToThread={mocks.navigation}
        />
        <LastCodeThreadProcesses
          threadRef={target}
          processes={queryProcesses}
          cleanupBlocked={value.worktreeCleanup != null}
          navigateToThread={mocks.navigation}
        />
      </div>
    </LastCodeSidebarPresentationProvider>
  );
}
let root: Root | null = null,
  container: HTMLDivElement | null = null;
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
  mocks.previewPermission = true;
  mocks.readScope.mockImplementation(() => mocks.previewPermission);
  mocks.useScope.mockImplementation(() => mocks.previewPermission);
  mocks.project.mockReturnValue({ workspaceRoot: "/own-project", title: "Own", faviconPath: null });
  mocks.status.mockImplementation((input) => input);
  mocks.query.mockReturnValue({ data: { refName: "feature" } });
  mocks.linked.mockReturnValue(null);
  mocks.prPresentation.mockReturnValue(null);
  mocks.terminalPresentation.mockReturnValue(null);
  mocks.multi.mockReturnValue(true);
  mocks.terminals.mockReturnValue([]);
  mocks.previews.mockReturnValue([]);
  mocks.supportsProcesses.mockReturnValue(true);
  mocks.ports.mockReturnValue([]);
  mocks.openPort.mockResolvedValue(AsyncResult.success(undefined));
  mocks.navigation.mockResolvedValue(undefined);
  mocks.openPr.mockImplementation((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  });
});
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
});
async function render(props: React.ComponentProps<typeof Harness> = {}) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(() => root!.render(<Harness {...props} />));
}
async function click(element: HTMLElement) {
  await act(() => element.click());
}
describe("row-owned query and control seams", () => {
  it("refreshes shared PR opening choices on the same mounted control", async () => {
    const value = { ...thread, pullRequests: [link] };
    mocks.openPr.mockReturnValue(true);
    await render({ value, panel: true });
    const anchor = container!.querySelector("a")!;
    await click(anchor);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), anchor.href, ref);
    expect(mocks.navigation).toHaveBeenCalledOnce();
    await render({ value, panel: false });
    expect(container!.querySelector("a")).toBe(anchor);
    await click(anchor);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), anchor.href, undefined);
    expect(mocks.navigation).toHaveBeenCalledOnce();
    await render({ value, panel: true, active: true });
    await click(anchor);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), anchor.href, ref);
    expect(mocks.navigation).toHaveBeenCalledOnce();
  });
  it("queries the exact physical project once and favors worktree over own cwd over representative fallback", async () => {
    await render({ value: { ...thread, worktreePath: "/own-worktree" } });
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(mocks.project).toHaveBeenCalledWith(
      scopeProjectRef(thread.environmentId, thread.projectId),
    );
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenLastCalledWith({
      environmentId: thread.environmentId,
      input: { cwd: "/own-worktree", includeRemote: false },
    });
    expect(source.gitCwd).toBe("/own-worktree");
    expect(source.threadProjectCwd).toBe("/own-project");
    await render();
    expect(source.gitCwd).toBe("/own-project");
    mocks.project.mockReturnValue(null);
    await render();
    expect(source.gitCwd).toBe("/representative-project");
  });
  it("keeps a colliding thread ID in its own environment and project", async () => {
    const value = {
      ...thread,
      environmentId: EnvironmentId.make("second-environment"),
      projectId: ProjectId.make("second-project"),
    };
    await render({ value });
    expect(mocks.project).toHaveBeenCalledWith(
      scopeProjectRef(value.environmentId, value.projectId),
    );
    expect(mocks.status).toHaveBeenCalledWith({
      environmentId: value.environmentId,
      input: { cwd: "/own-project", includeRemote: false },
    });
    expect(mocks.linked.mock.calls[0]?.[0]).toBe(value.environmentId);
  });
  it("retains lease-gated git and linked PR reads without fetching again in sibling controls", async () => {
    await render({ live: false });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(null);
    expect(mocks.linked).toHaveBeenCalledOnce();
    expect(mocks.linked.mock.calls[0]?.[2]).toBe(false);
    expect(mocks.terminals).toHaveBeenCalledOnce();
    expect(mocks.previews).toHaveBeenCalledOnce();
    expect(mocks.ports).toHaveBeenCalledOnce();
    expect(mocks.terminals).toHaveBeenCalledWith({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    expect(mocks.previews).toHaveBeenCalledWith(ref);
  });
  it("does not request git status for linked PRs, branchless threads or missing cwd", async () => {
    await render({
      value: {
        ...thread,
        linkedPullRequest: {
          projectId: thread.projectId,
          repository: link.repository,
          number: link.number,
          url: link.url,
        },
      },
    });
    expect(mocks.status).not.toHaveBeenCalled();
    await render({ value: { ...thread, branch: null } });
    expect(mocks.status).not.toHaveBeenCalled();
    mocks.project.mockReturnValue(null);
    await render({ fallback: null });
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("shares terminal/preview capability while keeping terminals distinct from preview-only work", async () => {
    mocks.previews.mockReturnValue([{}]);
    await render();
    expect(processes.hasStoppableProcesses).toBe(true);
    expect(processes.terminalStatus).toBeNull();
    mocks.supportsProcesses.mockReturnValue(false);
    await render();
    expect(processes.hasStoppableProcesses).toBe(false);
    mocks.terminals.mockReturnValue(["running-terminal"]);
    mocks.terminalPresentation.mockReturnValue({
      label: "Terminal process running",
      colorClass: "text-muted-foreground",
      pulse: true,
    });
    await render();
    expect(processes.terminalStatus?.label).toBe("Terminal process running");
    expect(container!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Terminal process running",
    );
  });
  it("shares resolved PR status and uses that URL before any pending link", async () => {
    const pr = {
      number: 18,
      url: "https://github.com/example/project/pull/18",
      title: "Resolved",
      state: "open",
      isDraft: false,
    };
    mocks.linked.mockReturnValue({ pr, sourceControlProvider: "github" });
    mocks.prPresentation.mockReturnValue({
      url: pr.url,
      colorClass: "text-muted-foreground",
      tooltip: "Resolved PR",
    });
    await render({ value: { ...thread, pullRequests: [link] } });
    expect(container!.querySelectorAll("a")).toHaveLength(1);
    await click(container!.querySelector("a")!);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), pr.url, ref);
    expect(mocks.prPresentation).toHaveBeenCalledWith(pr, "github");
  });
  it("keeps local branch mismatch in shared details and excludes worktree mismatch", async () => {
    mocks.query.mockReturnValue({ data: { refName: "different" } });
    await render();
    expect(source.branchMismatch).toEqual({ threadBranch: "feature", currentBranch: "different" });
    await render({ value: { ...thread, worktreePath: "/own-worktree" } });
    expect(source.branchMismatch).toBeNull();
  });
  it("suppresses resolved PR and port controls during cleanup while retaining terminal status", async () => {
    mocks.linked.mockReturnValue({
      pr: { number: 18, url: link.url, title: "Resolved", state: "open", isDraft: false },
    });
    mocks.prPresentation.mockReturnValue({
      url: link.url,
      colorClass: "text-muted-foreground",
      tooltip: "Resolved PR",
    });
    mocks.ports.mockReturnValue([port]);
    mocks.terminalPresentation.mockReturnValue({
      label: "Terminal process running",
      colorClass: "text-muted-foreground",
      pulse: false,
    });
    await render({
      value: {
        ...thread,
        worktreeCleanup: {
          status: "deleting",
          repositoryRoot: "/repository",
          worktreePath: "/worktree",
          startedAt: "2026-01-01T00:00:00Z",
        },
      },
    });
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.querySelector("button")).toBeNull();
    expect(container!.querySelector('[role="img"]')).not.toBeNull();
  });
  it("opens a pending PR for the exact environment and navigates only when right-panel opening needs it", async () => {
    const value = { ...thread, pullRequests: [link] };
    await render({ value });
    await click(container!.querySelector("a")!);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), link.url, ref);
    expect(mocks.navigation).toHaveBeenCalledWith(ref);
    expect(mocks.bubble).not.toHaveBeenCalled();
    mocks.navigation.mockClear();
    await render({ value, active: true });
    await click(container!.querySelector("a")!);
    expect(mocks.navigation).not.toHaveBeenCalled();
    await render({ value, panel: false });
    await click(container!.querySelector("a")!);
    expect(mocks.openPr).toHaveBeenLastCalledWith(expect.anything(), link.url, undefined);
    expect(mocks.navigation).not.toHaveBeenCalled();
    mocks.openPr.mockReturnValue(false);
    await render({ value });
    await click(container!.querySelector("a")!);
    expect(mocks.navigation).not.toHaveBeenCalled();
  });
  it("leaves pending PR display disabled when the environment lacks multiple-PR capability", async () => {
    mocks.multi.mockReturnValue(false);
    await render({ value: { ...thread, pullRequests: [link] } });
    expect(container!.querySelector("a")).toBeNull();
  });
  it("opens the first discovered port with the current scoped destination and preview command", async () => {
    mocks.ports.mockReturnValue([port, { ...port, port: 5174 }]);
    await render();
    await click(container!.querySelector("button")!);
    expect(mocks.navigation).toHaveBeenCalledWith(ref);
    expect(mocks.openPort).toHaveBeenCalledWith({
      threadRef: ref,
      port,
      openPreview: mocks.previewCommand,
    });
    expect(mocks.bubble).not.toHaveBeenCalled();
    expect(mocks.navigation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openPort.mock.invocationCallOrder[0]!,
    );
  });
  it("rechecks preview permission at click time independently of task permission", async () => {
    mocks.ports.mockReturnValue([port]);
    await render();
    mocks.previewPermission = false;
    await click(container!.querySelector("button")!);
    expect(mocks.openPort).not.toHaveBeenCalled();
    expect(mocks.navigation).not.toHaveBeenCalled();
    expect(mocks.readScope).toHaveBeenCalledWith(ref.environmentId, AuthPreviewOperateScope);
    await act(() => mocks.scopeListeners.forEach((listener) => listener()));
    expect(container!.querySelector("button")).toBeNull();
  });
  it("reports preview failure but suppresses interruption without changing navigation order", async () => {
    mocks.ports.mockReturnValue([port]);
    mocks.openPort.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Unavailable"))));
    await render();
    await click(container!.querySelector("button")!);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to open preview", description: "Unavailable" }),
    );
    mocks.toast.mockClear();
    mocks.openPort.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await click(container!.querySelector("button")!);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
