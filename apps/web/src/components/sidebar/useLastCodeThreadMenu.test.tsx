// @vitest-environment happy-dom
import { act } from "react";
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
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import {
  scopeThreadRef,
  scopeProjectRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../logicalProject";
import type { HandoffEntry } from "../../handoffs/handoffsStore";
import type { LastCodeThreadActions } from "./LastCodeThreadActions";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { makeThreadFixture } from "../../test-fixtures";
import { useLastCodeBulkThreadMenu } from "./useLastCodeBulkThreadMenu";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useLastCodeThreadMenu } from "./useLastCodeThreadMenu";

const mocks = vi.hoisted(() => ({
  menu: vi.fn<
    (
      items: readonly ContextMenuItem<string>[],
      position?: { x: number; y: number },
    ) => Promise<string | null>
  >(),
  confirm: vi.fn(async () => true),
  canOperate: true,
  readProject: vi.fn(() => undefined),
  shell: vi.fn(),
  handoffs: [] as HandoffEntry[],
  metadata: vi.fn<(value: unknown) => Promise<AtomCommandResult<unknown, unknown>>>(),
  unread: vi.fn(),
  read: vi.fn(),
  archive: vi.fn<LastCodeThreadActions["archiveThreads"]>(),
  persistence: vi.fn<LastCodeThreadActions["setThreadPersistence"]>(),
  unarchive: vi.fn<LastCodeThreadActions["unarchiveThread"]>(),
  delete: vi.fn<LastCodeThreadActions["deleteThread"]>(),
  stop: vi.fn(async () => {}),
  copy: vi.fn(),
  navigate: vi.fn(async (_value: unknown) => {}),
  navigateThread: vi.fn(async () => {}),
  openHandoff: vi.fn(async () => {}),
  openPanel: vi.fn(),
  closeMobile: vi.fn(),
  rename: vi.fn(),
  annotate: vi.fn(),
  newThread: vi.fn<ReturnType<typeof useNewThreadHandler>>(async () => null),
  toast: vi.fn(),
  settings: {
    handoffsMenuLimit: 1,
    confirmThreadDelete: true,
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  } as ProjectGroupingSettings & { handoffsMenuLimit: number; confirmThreadDelete: boolean },
}));
vi.mock("./LastCodeThreadActions", () => ({
  useLastCodeThreadActions: () => ({
    archiveThreads: mocks.archive,
    markThreadUnread: mocks.unread,
    markThreadRead: mocks.read,
    setThreadPersistence: mocks.persistence,
    unarchiveThread: mocks.unarchive,
    deleteThread: mocks.delete,
  }),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: mocks.menu }, dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../../state/entities", () => ({
  readProject: mocks.readProject,
  readThreadShell: mocks.shell,
  readEnvironmentSupportsThreadAnnotations: () => true,
  readEnvironmentSupportsPersistence: () => true,
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => mocks.canOperate }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.metadata,
  ORCHESTRATION_OPERATE_DENIED_MESSAGE: "Read-only environment",
}));
vi.mock("../../state/previewHosting", () => ({ useStopThreadProcesses: () => mocks.stop }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof mocks.settings) => unknown) =>
    select(mocks.settings),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: mocks.copy }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: mocks.navigate }) }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: true, setOpenMobile: mocks.closeMobile }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../../handoffs/handoffsStore", () => ({ readThreadHandoffs: () => mocks.handoffs }));
vi.mock("../../handoffs/handoffMenu", () => ({
  describeHandoff: (entry: HandoffEntry) => ({ entry, label: entry.title ?? entry.id }),
}));
vi.mock("../../handoffs/useOpenHandoff", () => ({ useOpenHandoff: () => mocks.openHandoff }));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ open: mocks.openPanel }) },
}));
const env = EnvironmentId.make("remote-member"),
  id = ProjectId.make("same-project");
const member: SidebarProjectGroupMember = {
  id,
  environmentId: env,
  title: "Remote",
  workspaceRoot: "/workspace/remote",
  physicalProjectKey: "remote-member:physical",
  environmentLabel: "Remote",
  repositoryIdentity: null,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  scripts: [],
};
const representative = {
  ...member,
  environmentId: EnvironmentId.make("local-member"),
  workspaceRoot: "/workspace/local",
  physicalProjectKey: "local-member:physical",
};
const project: SidebarProjectSnapshot = {
  ...representative,
  projectKey: "group",
  displayName: "Group",
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [representative, member],
  memberProjectRefs: [scopeProjectRef(representative.environmentId, id), scopeProjectRef(env, id)],
  remoteEnvironmentLabels: ["Remote"],
};
const baseThread = makeThreadFixture({
  id: ThreadId.make("same-thread"),
  environmentId: env,
  projectId: id,
  branch: "feature",
  latestUserMessageAt: "2026-01-01T00:00:00Z",
  creatorThreadId: ThreadId.make("creator"),
  creatorGrouping: "grouped",
});
const thread = { ...baseThread, source: { ...baseThread.source, createdBy: "agent" as const } };
const ref = scopeThreadRef(env, thread.id);
let currentThread = thread;
let pending: Promise<void> | null = null;
function Harness() {
  const show = useLastCodeThreadMenu(
    project,
    () => currentThread,
    mocks.rename,
    mocks.annotate,
    mocks.navigateThread,
    mocks.newThread,
  );
  return (
    <button
      onClick={() => {
        pending = show(ref, { x: 10, y: 20 }, true);
      }}
    >
      Menu
    </button>
  );
}
function BulkHarness() {
  const show = useLastCodeBulkThreadMenu();
  return (
    <button
      onClick={() => {
        pending = show({ x: 10, y: 20 });
      }}
    >
      Menu
    </button>
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
  useThreadSelectionStore.getState().clearSelection();
  mocks.archive.mockResolvedValue({
    archivedThreadKeys: [],
    mutationFailure: null,
    followupFailures: [],
  });
  currentThread = thread;
  mocks.canOperate = true;
  mocks.handoffs = [];
  mocks.menu.mockResolvedValue(null);
  mocks.settings.confirmThreadDelete = true;
  mocks.confirm.mockResolvedValue(true);
  mocks.metadata.mockResolvedValue(AsyncResult.success(undefined));
  mocks.newThread.mockResolvedValue(null);
  mocks.persistence.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  mocks.unarchive.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  mocks.delete.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  mocks.shell.mockImplementation((target) =>
    target.threadId === ThreadId.make("creator")
      ? makeThreadFixture({
          id: target.threadId,
          environmentId: target.environmentId,
          projectId: id,
        })
      : currentThread,
  );
});
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  pending = null;
  document.body.replaceChildren();
});
async function render(bulk = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(bulk ? <BulkHarness /> : <Harness />));
}
async function select(action: string | null) {
  mocks.menu.mockResolvedValueOnce(action);
  await act(async () => {
    container!.querySelector<HTMLButtonElement>("button")!.click();
    await pending;
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("thread menu binding and scoped targets", () => {
  it("copies the clicked member path and carries its environment and branch into new thread creation", async () => {
    await render();
    await select("copy-path");
    expect(mocks.copy).toHaveBeenCalledWith(member.workspaceRoot, { path: member.workspaceRoot });
    expect(mocks.readProject).toHaveBeenCalledWith(scopeProjectRef(env, id));
    await select("new-thread-on-branch");
    expect(mocks.newThread).toHaveBeenCalledWith(scopeProjectRef(env, id), {
      branch: "feature",
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
    expect(mocks.closeMobile).not.toHaveBeenCalled();
  });
  it("checks permission again after a deferred menu closes, leaving readonly navigation available", async () => {
    await render();
    const menu = deferred<string | null>();
    mocks.menu.mockReturnValueOnce(menu.promise);
    await act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
    mocks.canOperate = false;
    await act(async () => {
      menu.resolve("mark-persistent");
      await pending;
    });
    expect(mocks.persistence).not.toHaveBeenCalled();
    await select("open-dashboard");
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/dashboard",
      search: { environmentId: env, projectId: id },
    });
    await select("mark-unread");
    expect(mocks.unread).toHaveBeenCalledWith(ref);
    await select("mark-read");
    expect(mocks.read).toHaveBeenCalledWith(ref);
  });
  it("routes handoff IDs with colons from the menu snapshot without normal selection navigation", async () => {
    const handoff: HandoffEntry = {
      id: "remote:entry",
      target: { kind: "file", path: "/workspace/remote/readme.md" },
      title: "Read",
      lastOpenedAt: 0,
      sequence: 1,
    };
    mocks.handoffs = [handoff];
    await render();
    await select("handoff:remote:entry");
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: env, threadId: thread.id },
    });
    expect(mocks.openHandoff).toHaveBeenCalledWith(ref, handoff);
    expect(mocks.navigateThread).not.toHaveBeenCalled();
    await select("handoff-show-all");
    expect(mocks.openPanel).toHaveBeenCalledWith(ref, "handoffs");
  });
  it("dispatches creator direction and navigation to the exact scoped creator", async () => {
    await render();
    await select("creator-independent");
    expect(mocks.metadata).toHaveBeenCalledWith({
      environmentId: env,
      input: { threadId: thread.id, creatorGrouping: "independent" },
    });
    await select("creator-grouped");
    expect(mocks.metadata).toHaveBeenCalledWith({
      environmentId: env,
      input: { threadId: thread.id, creatorGrouping: "grouped" },
    });
    await select("open-creator");
    expect(mocks.navigateThread).toHaveBeenCalledWith(
      scopeThreadRef(env, ThreadId.make("creator")),
    );
  });
  it("passes the pending archive command identity and reports new-thread failures", async () => {
    currentThread = {
      ...thread,
      archivePending: {
        threadId: ThreadId.make("archive-owner"),
        commandId: CommandId.make("archive-command"),
        status: "failed",
      },
    };
    await render();
    await select("dismiss-archive-failure");
    expect(mocks.unarchive).toHaveBeenCalledWith(
      scopeThreadRef(env, ThreadId.make("archive-owner")),
      { expectedArchiveCommandId: CommandId.make("archive-command") },
    );
    mocks.newThread.mockRejectedValueOnce(new Error("Creation failed"));
    await select("new-thread-on-branch");
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not create thread", description: "Creation failed" }),
    );
  });
  it("ignores cancelled, unknown and disabled guidance IDs", async () => {
    await render();
    for (const action of [null, "unknown", "constructor", "handoffs-heading", "handoffs-empty"])
      await select(action);
    expect(mocks.newThread).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
});

describe("bulk menu selection snapshot", () => {
  it.each(["mark-read", "mark-unread"] as const)(
    "applies %s to the original selection and preserves later selection",
    async (action) => {
      const firstKey = scopedThreadKey(ref),
        laterRef = scopeThreadRef(env, ThreadId.make("later")),
        laterKey = scopedThreadKey(laterRef);
      mocks.shell.mockImplementation((target) =>
        target.threadId === thread.id ? thread : { ...thread, id: laterRef.threadId },
      );
      useThreadSelectionStore.getState().toggleThread(firstKey);
      await render(true);
      const menu = deferred<string | null>();
      mocks.menu.mockReturnValueOnce(menu.promise);
      await act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
      await act(() => useThreadSelectionStore.getState().toggleThread(laterKey));
      await act(async () => {
        menu.resolve(action);
        await pending;
      });
      expect(action === "mark-read" ? mocks.read : mocks.unread).toHaveBeenCalledExactlyOnceWith(
        ref,
      );
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        firstKey,
        laterKey,
      ]);
    },
  );
  it("retains selection and does not acknowledge anything when a bulk menu is cancelled", async () => {
    const key = scopedThreadKey(ref);
    useThreadSelectionStore.getState().toggleThread(key);
    await render(true);
    await select(null);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.unread).not.toHaveBeenCalled();
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([key]);
  });
  it("clears original excluded keys after full archive success while retaining later selection", async () => {
    const cleanup = makeThreadFixture({
      id: ThreadId.make("cleanup"),
      environmentId: env,
      worktreeCleanup: {
        status: "deleting",
        repositoryRoot: "/workspace/example",
        worktreePath: "/workspace/example-worktree",
        startedAt: "2026-01-01T00:00:00Z",
      },
    });
    const cleanupKey = scopedThreadKey(scopeThreadRef(env, cleanup.id));
    const missingKey = scopedThreadKey(scopeThreadRef(env, ThreadId.make("missing")));
    const firstKey = scopedThreadKey(ref);
    const laterKey = scopedThreadKey(scopeThreadRef(env, ThreadId.make("later")));
    mocks.shell.mockImplementation((target) =>
      target.threadId === thread.id ? thread : target.threadId === cleanup.id ? cleanup : null,
    );
    const selection = useThreadSelectionStore.getState();
    for (const key of [firstKey, cleanupKey, missingKey]) selection.toggleThread(key);
    await render(true);
    const menu = deferred<string | null>();
    mocks.menu.mockReturnValueOnce(menu.promise);
    await act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.menu.mock.calls[0]?.[0].find((item) => item.id === "archive")?.label).toBe(
      "Archive (1)",
    );
    await act(() => selection.toggleThread(laterKey));
    await act(async () => {
      menu.resolve("archive");
      await pending;
    });
    expect(mocks.archive).toHaveBeenCalledWith([{ threadKey: firstKey, threadRef: ref, thread }]);
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([laterKey]);
  });
  it("preserves selection when permission is revoked while the bulk menu is open", async () => {
    const key = scopedThreadKey(ref);
    useThreadSelectionStore.getState().toggleThread(key);
    await render(true);
    const menu = deferred<string | null>();
    mocks.menu.mockReturnValueOnce(menu.promise);
    await act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
    mocks.canOperate = false;
    await act(async () => {
      menu.resolve("delete");
      await pending;
    });
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([key]);
  });
});
