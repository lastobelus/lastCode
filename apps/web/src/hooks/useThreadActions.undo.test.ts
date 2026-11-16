import { EnvironmentId, ThreadId, getOwnedThreadFamily } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { announce } from "../lib/announce";
import { makeThreadFixture } from "../test-fixtures";
import { useThreadSelectionStore } from "../threadSelectionStore";

const familyState = vi.hoisted(() => ({
  threads: [] as ReturnType<typeof makeThreadFixture>[],
  archiveSupport: true as boolean | undefined,
  hiddenThreadIds: new Set<ThreadId>(),
  confirmArchive: false,
  unsupportedEnvironments: new Set<string>(),
}));
const newThread = vi.hoisted(() => vi.fn());
const archiveDialog = vi.hoisted(() => vi.fn());
const archiveFamilyLoad = vi.hoisted(() => vi.fn());
vi.mock("../components/ThreadArchiveDialog", () => ({ requestThreadArchiveDialog: archiveDialog }));

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  delete: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  reorderActive: vi.fn(),
}));
const router = vi.hoisted(() => {
  const listeners = new Set<(event: { action: { type: string } }) => void>();
  return {
    navigate: vi.fn(async () => {}),
    state: { location: { href: "/" }, matches: [{ params: {} as Record<string, string> }] },
    history: {
      listeners,
      subscribe: (listener: (event: { action: { type: string } }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("./useWorkspaceLifecycleConfirmation", async (original) => ({
  ...(await original<typeof import("./useWorkspaceLifecycleConfirmation")>()),
  useWorkspaceLifecycleConfirmation: () => ({
    supported: () => false,
    confirm: () => {
      throw new Error("These Undo fixtures do not support saved workspaces.");
    },
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
const archiveConfirm = vi.hoisted(() => vi.fn());
vi.mock("./useSettings", () => ({ useClientSettings: () => familyState.confirmArchive }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: archiveConfirm } }) }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  activeOrderKey: null as string | null,
  unsettledAt: null as string | null,
  snoozedUntil: null as string | null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
// Archived rows have no loaded shell, so deleting one takes the unresolved path.
const shellLoaded = vi.hoisted(() => ({ current: true }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsArchiveFamilies: (environmentId: string) =>
    familyState.archiveSupport === true && !familyState.unsupportedEnvironments.has(environmentId),
  readThreadShell: (target: { threadId: ThreadId; environmentId: EnvironmentId }) =>
    !shellLoaded.current || familyState.hiddenThreadIds.has(target.threadId)
      ? null
      : (familyState.threads.find(
          (thread) =>
            thread.id === target.threadId && thread.environmentId === target.environmentId,
        ) ?? {
          ...makeThreadFixture({ id: target.threadId, environmentId: target.environmentId }),
          ...threadShell,
          id: target.threadId,
          environmentId: target.environmentId,
        }),
  readThreadShells: () => familyState.threads,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.loadArchiveFamily:
        return async (target: { environmentId: EnvironmentId; input: { threadId: ThreadId } }) => {
          const result = await archiveFamilyLoad(target);
          return result._tag === "Success" && Array.isArray(result.value)
            ? { ...result, value: archiveDecisionFixture(result.value, target) }
            : result;
        };
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.delete:
        return commands.delete;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      case threadEnvironment.reorderActive:
        return commands.reorderActive;
      default:
        return vi.fn();
    }
  },
}));

// Simulated server decisions for fixtures; the hook receives the authoritative command result.
function archiveDecisionFixture(
  threads: ReturnType<typeof makeThreadFixture>[],
  target: { environmentId: EnvironmentId; input: { threadId: ThreadId } },
) {
  const shells = threads
    .filter((thread) => thread.environmentId === target.environmentId)
    .map((thread) => ({ ...thread, creationSource: thread.source.creationSource }));
  const family = getOwnedThreadFamily(shells, target.input.threadId);
  const participants = shells.filter(
    (thread) =>
      thread.id === target.input.threadId ||
      family.children.some((child) => child.id === thread.id),
  );
  const activeThreads = participants.filter(
    (thread) =>
      threadRuntimeIsActive(thread.runtime) ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput,
  );
  const unreadThreads = participants.filter(
    (thread) =>
      thread.latestRun?.status === "completed" &&
      thread.latestRun.completedAt !== null &&
      (thread.lastVisitedAt == null || thread.latestRun.completedAt > thread.lastVisitedAt),
  );
  const activeChildren = family.children.filter((child) =>
    activeThreads.some((thread) => thread.id === child.id),
  );
  return {
    threads,
    children: family.children,
    activeChildren,
    activeThreads,
    unreadThreads,
    protectedChildren: family.protectedChildren,
    childThreadIds: family.children.map((thread) => thread.id),
    activeThreadIds: activeThreads.map((thread) => thread.id),
    unreadThreadIds: unreadThreads.map((thread) => thread.id),
    activeChildThreadIds: activeChildren.map((thread) => thread.id),
    protectedChildThreadIds: family.protectedChildren.map((thread) => thread.id),
    promotableChildThreadIds: [],
    keptThreadIds: [],
    nativeStopCount: family.nativeChildren.length,
    requiresConfirmation:
      activeThreads.length > 0 || unreadThreads.length > 0 || family.protectedChildren.length > 0,
    canPromote: false,
    canStopAndArchive: family.protectedChildren.length === 0,
  };
}

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  useThreadSelectionStore.getState().clearSelection();
  familyState.threads = [];
  familyState.hiddenThreadIds.clear();
  familyState.archiveSupport = true;
  familyState.confirmArchive = false;
  archiveConfirm.mockReset().mockResolvedValue(true);
  familyState.unsupportedEnvironments.clear();
  newThread.mockReset().mockImplementation(async () => {
    router.state.location.href = "/draft/project";
  });
  archiveDialog.mockReset();
  archiveFamilyLoad.mockReset().mockImplementation(async ({ environmentId, input }) => ({
    _tag: "Success",
    value: [
      familyState.threads.find(
        (thread) => thread.id === input.threadId && thread.environmentId === environmentId,
      ) ?? makeThreadFixture({ id: input.threadId, environmentId }),
      ...familyState.threads.filter((thread) => thread.id !== input.threadId),
    ],
  }));
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  router.navigate.mockClear();
  router.state.location.href = "/";
  router.state.matches = [{ params: {} }];
  threadShell.pinnedAt = null;
  threadShell.activeOrderKey = null;
  threadShell.unsettledAt = null;
  threadShell.snoozedUntil = null;
  shellLoaded.current = true;
});
afterEach(() => {
  useThreadSelectionStore.getState().clearSelection();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("concurrent thread action Undo", () => {
  it.each([
    ["settleThread", "settle", "unsettle", "Settled"],
    ["snoozeThread", "snooze", "unsnooze", "Snoozed"],
    ["unpinThread", "unpin", "pin", "Unpinned"],
    ["archiveThread", "archive", "unarchive", "Archived"],
  ] as const)(
    "%s retains one undo for concurrent successful requests",
    async (handler, action, inverse, notice) => {
      const actions = useThreadActions();
      const run = () =>
        handler === "snoozeThread"
          ? actions.snoozeThread(target, "2099-01-01T09:00:00.000Z")
          : actions[handler](target);
      await Promise.all([run(), run()]);
      expect(commands[action]).toHaveBeenCalledTimes(2);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: notice, count: 1 });
      await currentUndo()();
      expect(commands[inverse]).toHaveBeenCalledOnce();
    },
  );
});

describe("pin", () => {
  it("announces that the thread was pinned", async () => {
    vi.mocked(announce).mockClear();
    await useThreadActions().pinThread(target);
    expect(announce).toHaveBeenCalledExactlyOnceWith("Pinned 1 thread");
  });
});

describe("unpin Undo", () => {
  it("restores the original snooze after restoring the pin", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    vi.mocked(announce).mockClear();
    await currentUndo()();
    expect(announce).not.toHaveBeenCalledWith("Pinned 1 thread");
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil: threadShell.snoozedUntil },
    });
    expect(commands.pin.mock.invocationCallOrder[0]).toBeLessThan(
      commands.snooze.mock.invocationCallOrder[0]!,
    );
  });

  it("restores the pin without an already expired snooze", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2000-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    await currentUndo()();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("ignores an old notice across hook instances and still restores the latest unpin", async () => {
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = currentUndo();
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = currentUndo();
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});

describe("delete navigation", () => {
  it.each([
    { type: "REPLACE", by: "the app's missing-thread redirect", fallsBack: true },
    { type: "PUSH", by: "the user opening another thread", fallsBack: false },
  ])("falls back: $fallsBack after $by while deleting", async ({ type, fallsBack }) => {
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    commands.delete.mockImplementation(async () => {
      for (const listener of router.history.listeners) listener({ action: { type } });
      return { _tag: "Success", value: undefined };
    });
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(router.navigate).toHaveBeenCalledTimes(fallsBack ? 1 : 0);
    expect(router.history.listeners.size).toBe(0);
  });
});

describe("settle and snooze Undo", () => {
  it("un-settles from the notice and expires the Undo after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled", count: 1 });
    expect(add).not.toHaveBeenCalled();
    const undo = currentUndo();
    await actions.unsettleThread(target);
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
  });

  it("puts a manually ordered thread back in its active position", async () => {
    threadShell.activeOrderKey = "b5";
    await useThreadActions().settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.reorderActive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "b5" },
    });
    expect(commands.unsettle.mock.invocationCallOrder[0]).toBeLessThan(
      commands.reorderActive.mock.invocationCallOrder[0]!,
    );
  });

  it("puts an automatically ordered thread back at its Active anchor", async () => {
    threadShell.unsettledAt = "2026-01-02T00:00:00.000Z";
    await useThreadActions().settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        reason: "user",
        restoreUnsettledAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(commands.reorderActive).not.toHaveBeenCalled();
  });

  it("stops settle restoration if restoring the pin fails", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    commands.pin.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Pin failed")) });
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  // regression: #12972 the sidebar undo notice must reverse a snooze
  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.snoozeThread(target, "2100-01-01T00:00:00.000Z");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});

describe("archive and delete Undo expiry", () => {
  const otherThread = { environmentId: target.environmentId, threadId: ThreadId.make("other") };
  const otherEnvironment = {
    environmentId: EnvironmentId.make("other-env"),
    threadId: target.threadId,
  };
  const failure = { _tag: "Failure", cause: Cause.fail(new Error("Request failed")) };

  describe.each(["archiveThread", "deleteThread"] as const)("%s", (lifecycle) => {
    it.each([
      ["settleThread", "unsettle"],
      ["snoozeThread", "unsnooze"],
      ["unpinThread", "pin"],
    ] as const)(
      "expires an earlier %s Undo for that thread only, across hook instances",
      async (handler, inverse) => {
        const sidebar = useThreadActions();
        const header = useThreadActions();
        for (const ref of [otherThread, otherEnvironment, target]) {
          await (handler === "snoozeThread"
            ? sidebar.snoozeThread(ref, "2099-01-01T09:00:00.000Z")
            : sidebar[handler](ref));
        }
        const staleUndo = currentUndo();
        await header[lifecycle](target);
        await staleUndo();
        expect(commands[inverse]).toHaveBeenCalledTimes(2);
        expect(commands[inverse]).not.toHaveBeenCalledWith(
          expect.objectContaining({
            environmentId: target.environmentId,
            input: expect.objectContaining({ threadId: target.threadId }),
          }),
        );
      },
    );

    it("keeps the earlier Undo when the request fails", async () => {
      const actions = useThreadActions();
      await actions.settleThread(target);
      commands[lifecycle === "archiveThread" ? "archive" : "delete"].mockResolvedValue(failure);
      await actions[lifecycle](target);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled" });
      await currentUndo()();
      expect(commands.unsettle).toHaveBeenCalledOnce();
    });
  });

  it.each([true, false])(
    "expires the Archived Undo when deleting with shell loaded: %s",
    async (loaded) => {
      const actions = useThreadActions();
      await actions.archiveThread(target);
      const staleUndo = currentUndo();
      shellLoaded.current = loaded;
      await actions.deleteThread(target);
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      await staleUndo();
      expect(commands.unarchive).not.toHaveBeenCalled();
    },
  );
});
