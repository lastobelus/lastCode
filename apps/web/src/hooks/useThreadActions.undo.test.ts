import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  getOwnedThreadFamily,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE } from "@t3tools/client-runtime/state/thread-archive";
import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { makeThreadFixture } from "../test-fixtures";
import { useThreadSelectionStore } from "../threadSelectionStore";

const familyState = vi.hoisted(() => ({
  threads: [] as ReturnType<typeof makeThreadFixture>[],
  archiveSupport: true as boolean | undefined,
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
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
}));
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: { matches: [{ params: {} as Record<string, string> }] },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => vi.fn(),
}));
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
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
const archiveConfirm = vi.hoisted(() => vi.fn());
vi.mock("./useSettings", () => ({ useClientSettings: () => familyState.confirmArchive }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: archiveConfirm } }) }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => newThread }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedUntil: null as string | null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsArchiveFamilies: (environmentId: string) =>
    familyState.archiveSupport === true && !familyState.unsupportedEnvironments.has(environmentId),
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (target: { threadId: ThreadId; environmentId: EnvironmentId }) =>
    familyState.threads.find(
      (thread) => thread.id === target.threadId && thread.environmentId === target.environmentId,
    ) ?? { ...threadShell, id: target.threadId, environmentId: target.environmentId },
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
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
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
    promotableChildren: [],
    protectedChildren: family.protectedChildren,
    childThreadIds: family.children.map((thread) => thread.id),
    activeThreadIds: activeThreads.map((thread) => thread.id),
    unreadThreadIds: unreadThreads.map((thread) => thread.id),
    promotableChildThreadIds: [],
    activeChildThreadIds: activeChildren.map((thread) => thread.id),
    protectedChildThreadIds: family.protectedChildren.map((thread) => thread.id),
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
  familyState.archiveSupport = true;
  familyState.confirmArchive = false;
  archiveConfirm.mockReset().mockResolvedValue(true);
  familyState.unsupportedEnvironments.clear();
  newThread.mockReset().mockResolvedValue(undefined);
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
  router.state.matches = [{ params: {} }];
  threadShell.pinnedAt = null;
  threadShell.snoozedUntil = null;
});
afterEach(() => {
  useThreadSelectionStore.getState().clearSelection();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unpin Undo", () => {
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

describe("archive Undo", () => {
  it("archives an idle thread with null runtime from a route without a thread", async () => {
    familyState.threads = [
      makeThreadFixture({
        environmentId: target.environmentId,
        id: target.threadId,
        runtime: null,
      }),
    ];
    router.state.matches = [];
    const result = await useThreadActions().archiveThread(target);
    expect(result._tag).toBe("Success");
    expect(commands.archive).toHaveBeenCalledOnce();
    expect(newThread).not.toHaveBeenCalled();
  });

  it("unarchives and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it("stays put when the archived thread was not open", async () => {
    const actions = useThreadActions();
    await actions.archiveThread(target);
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows no Undo when the archive failed", async () => {
    commands.archive.mockResolvedValue({ _tag: "Failure", cause: new Error("nope") });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().archiveThread(target);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("archive support under server version skew", () => {
  it.each([
    { support: undefined, bulk: false },
    { support: false, bulk: false },
    { support: undefined, bulk: true },
    { support: false, bulk: true },
  ])(
    "requires an update before querying or mutating (support=$support, bulk=$bulk)",
    async ({ support, bulk }) => {
      familyState.archiveSupport = support;
      const actions = useThreadActions();
      const failure = bulk
        ? (await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]))
            ?.mutationFailure
        : await actions.archiveThread(target);
      expect(failure?._tag).toBe("Failure");
      if (failure?._tag !== "Failure") throw new Error("Expected an update-required error");
      expect(Cause.squash(failure.cause)).toMatchObject({
        message: THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE,
      });
      expect(archiveFamilyLoad).not.toHaveBeenCalled();
      expect(commands.archive).not.toHaveBeenCalled();
      expect(archiveDialog).not.toHaveBeenCalled();
    },
  );

  it("checks every selected environment before a mixed bulk archive reads any family", async () => {
    const other = { ...target, environmentId: EnvironmentId.make("older-environment") };
    familyState.unsupportedEnvironments.add(other.environmentId);
    const outcome = await useThreadActions().archiveThreads([
      { threadRef: target, threadKey: "undo-env:thread" },
      { threadRef: other, threadKey: "older-environment:thread" },
    ]);
    expect(outcome?.mutationFailure?._tag).toBe("Failure");
    expect(archiveFamilyLoad).not.toHaveBeenCalled();
    expect(commands.archive).not.toHaveBeenCalled();
  });
});

describe("stranded archive retry navigation", () => {
  it.each([
    { source: "provider", choice: "stop_and_archive", route: "child", leaves: true, nested: false },
    { source: "mcp", choice: "stop_and_archive", route: "owner", leaves: true, nested: false },
    { source: "provider", choice: "stop_and_archive", route: "child", leaves: true, nested: true },
  ] as const)(
    "$choice of $source child on $route route leaves=$leaves",
    async ({ source, choice, route, leaves, nested }) => {
      const ownerId = ThreadId.make("archived-owner");
      const childId = ThreadId.make("stranded-child");
      const keptOwnerId = ThreadId.make("kept-owner");
      const inactiveId = ThreadId.make("inactive-intermediate");
      const expectedChildThreadIds = nested ? [keptOwnerId, childId] : [childId];
      const pending = {
        threadId: ownerId,
        commandId: CommandId.make("failed-archive"),
        childDisposition: "stop_and_archive" as const,
        childThreadIds: expectedChildThreadIds,
        archiveThreadIds: [ownerId, ...expectedChildThreadIds],
        promoteThreadIds: [],
        status: "failed" as const,
      };
      const owner = makeThreadFixture({
        id: ownerId,
        environmentId: target.environmentId,
        archivedAt: "2026-01-01T00:00:00.000Z",
        archivePending: pending,
      });
      const childShell = makeThreadFixture({
        id: childId,
        environmentId: owner.environmentId,
        archivePending: pending,
        hasPendingUserInput: true,
        lineage: {
          rootThreadId: ownerId,
          parentThreadId: nested ? inactiveId : ownerId,
          relationshipToParent: "subagent",
        },
      });
      const child = { ...childShell, source: { ...childShell.source, creationSource: source } };
      familyState.threads = [child];
      const branch = nested
        ? [
            makeThreadFixture({
              id: keptOwnerId,
              environmentId: owner.environmentId,
              archivePending: pending,
              lineage: {
                rootThreadId: ownerId,
                parentThreadId: ownerId,
                relationshipToParent: "subagent",
              },
            }),
            makeThreadFixture({
              id: inactiveId,
              environmentId: owner.environmentId,
              archivedAt: "2026-01-01T00:00:00.000Z",
              lineage: {
                rootThreadId: ownerId,
                parentThreadId: keptOwnerId,
                relationshipToParent: "subagent",
              },
            }),
          ]
        : [];
      archiveFamilyLoad.mockResolvedValue({ _tag: "Success", value: [owner, ...branch, child] });
      router.state.matches[0]!.params = {
        environmentId: target.environmentId,
        threadId: route === "child" ? childId : ownerId,
      };
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit(choice)).toBeNull();
        return choice;
      });
      await useThreadActions().archiveThread({ ...target, threadId: childId });
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: ownerId,
          childDisposition: choice,
          expectedChildThreadIds,
          expectedArchiveCommandId: pending.commandId,
        },
      });
      expect(newThread).toHaveBeenCalledTimes(leaves ? 1 : 0);
      await currentUndo()();
      expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: { threadId: ownerId },
      });
    },
  );

  it.each([false, true])(
    "does not turn a dismissed child retry into a fresh family archive (bulk=%s)",
    async (bulk) => {
      const pending = {
        threadId: target.threadId,
        commandId: CommandId.make("observed-failure"),
        status: "failed" as const,
      };
      const owner = makeThreadFixture({
        id: target.threadId,
        environmentId: target.environmentId,
        archivePending: pending,
      });
      const child = makeThreadFixture({
        id: ThreadId.make("failed-child"),
        environmentId: owner.environmentId,
        archivePending: pending,
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [owner, child];
      archiveFamilyLoad.mockImplementation(async () => {
        // Another client dismisses after the local retry target is captured.
        familyState.threads = [owner, child].map((thread) => ({ ...thread, archivePending: null }));
        return { _tag: "Success", value: familyState.threads };
      });
      commands.archive.mockImplementation(async ({ input }) =>
        input.expectedArchiveCommandId === undefined
          ? { _tag: "Success", value: undefined }
          : { _tag: "Failure", cause: Cause.fail(new Error("This failed archive changed.")) },
      );
      const childRef = { ...target, threadId: child.id };
      const actions = useThreadActions();
      const result = bulk
        ? (
            await actions.archiveThreads([
              { threadRef: childRef, threadKey: `${target.environmentId}:${child.id}` },
            ])
          )?.mutationFailure
        : await actions.archiveThread(childRef);
      expect(result?._tag).toBe("Failure");
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
          expectedArchiveCommandId: pending.commandId,
        },
      });
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(archiveConfirm).not.toHaveBeenCalled();
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      expect(newThread).not.toHaveBeenCalled();
    },
  );
});

describe("archive family confirmation", () => {
  function workingRoot(status: "preparing" | "starting" | "running" = "running") {
    return makeThreadFixture({
      id: target.threadId,
      environmentId: target.environmentId,
      runtime: {
        status,
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "codex",
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  function childOf(owner: ReturnType<typeof makeThreadFixture>, id = "child") {
    return makeThreadFixture({
      id: ThreadId.make(id),
      environmentId: owner.environmentId,
      lineage: {
        rootThreadId: owner.id,
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
      },
    });
  }

  async function archive(bulk: boolean) {
    const actions = useThreadActions();
    return bulk
      ? (await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]))
          ?.mutationFailure
      : await actions.archiveThread(target);
  }

  it.each([false, true])(
    "confirms a working owner and archives its idle children (bulk=%s)",
    async (bulk) => {
      const owner = { ...workingRoot(), title: "Authoritative title" };
      const child = childOf(owner);
      familyState.threads = [{ ...owner, runtime: null, title: "Stale title" }];
      archiveFamilyLoad.mockResolvedValue({ _tag: "Success", value: [owner, child] });
      archiveDialog.mockImplementation(async (request) => {
        if (!bulk) expect(request.title).toContain(owner.title);
        expect(
          request.family.threads.find((thread: { id: string }) => thread.id === owner.id)?.title,
        ).toBe(owner.title);
        expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
          child.id,
        ]);
        expect(request.family.activeThreadIds).toEqual([owner.id]);
        expect(commands.archive).not.toHaveBeenCalled();
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      await archive(bulk);
      expect(archiveFamilyLoad).toHaveBeenCalledOnce();
      expect(archiveDialog).toHaveBeenCalledOnce();
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  it.each([false, true])(
    "uses server decisions without inferring work from shell attention (bulk=%s)",
    async (bulk) => {
      const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = { ...childOf(owner), hasPendingUserInput: true };
      archiveFamilyLoad.mockResolvedValue({
        _tag: "Success",
        value: {
          ...archiveDecisionFixture([owner, child], {
            environmentId: target.environmentId,
            input: { threadId: owner.id },
          }),
          requiresConfirmation: false,
          activeThreadIds: [],
          activeThreads: [],
          activeChildren: [],
          activeChildThreadIds: [],
        },
      });
      await archive(bulk);
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  it("uses authoritative activity and protection even when local shells are idle", async () => {
    const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
    const child = childOf(owner);
    familyState.threads = [owner, child];
    archiveFamilyLoad.mockResolvedValue({
      _tag: "Success",
      value: {
        ...archiveDecisionFixture([owner, child], {
          environmentId: target.environmentId,
          input: { threadId: owner.id },
        }),
        requiresConfirmation: true,
        activeThreadIds: [child.id],
        protectedChildThreadIds: [child.id],
        canStopAndArchive: false,
      },
    });
    archiveDialog.mockImplementation(async (request) => {
      expect(request.family.activeThreadIds).toEqual([child.id]);
      expect(request.family.protectedChildThreadIds).toEqual([child.id]);
      expect(request.family.canStopAndArchive).toBe(false);
      return null;
    });
    expect((await archive(false))?._tag).toBe("Failure");
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(commands.archive).not.toHaveBeenCalled();
  });

  it.each(["none", "fork", "independent"] as const)(
    "confirms working standalone threads without archiving unowned branches (%s)",
    async (kind) => {
      const owner = workingRoot();
      const unrelated = {
        ...childOf(owner, "unowned-child"),
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: kind === "fork" ? ("fork" as const) : ("subagent" as const),
          ...(kind === "independent" ? { independent: true } : {}),
        },
      };
      familyState.threads = [owner];
      archiveFamilyLoad.mockResolvedValue({
        _tag: "Success",
        value: kind === "none" ? [owner] : [owner, unrelated],
      });
      archiveDialog.mockImplementation(async (request) => {
        expect(request.family.children).toEqual([]);
        expect(request.family.activeThreadIds).toEqual([owner.id]);
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      expect((await archive(false))?._tag).toBe("Success");
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [],
        },
      });
    },
  );

  it("reads every bulk family before confirming active standalone work", async () => {
    familyState.confirmArchive = true;
    const owner = workingRoot("starting");
    const eligible = makeThreadFixture({
      id: ThreadId.make("eligible-root"),
      environmentId: target.environmentId,
    });
    familyState.threads = [{ ...owner, runtime: null }, eligible];
    archiveFamilyLoad.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: input.threadId === owner.id ? [owner] : [eligible],
    }));
    archiveDialog.mockImplementation(async (request) => {
      expect(archiveFamilyLoad).toHaveBeenCalledTimes(2);
      expect(request.family.activeThreadIds).toEqual([owner.id]);
      expect(commands.archive).not.toHaveBeenCalled();
      expect(await request.submit("stop_and_archive")).toBeNull();
      return "stop_and_archive";
    });
    const selected = [eligible, owner].map((thread) => ({
      threadRef: { environmentId: thread.environmentId, threadId: thread.id },
      threadKey: `${thread.environmentId}:${thread.id}`,
    }));
    const outcome = await useThreadActions().archiveThreads(selected);
    expect(outcome?.mutationFailure).toBeNull();
    expect(outcome?.archivedThreadKeys).toEqual(selected.map(({ threadKey }) => threadKey));
    expect(archiveConfirm).not.toHaveBeenCalled();
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(commands.archive).toHaveBeenCalledTimes(2);
  });

  it("archives a selected working descendant once through its selected owner", async () => {
    const owner = workingRoot();
    const child = { ...childOf(owner), runtime: owner.runtime };
    familyState.threads = [owner, child];
    archiveDialog.mockImplementation(async (request) => {
      expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
        child.id,
      ]);
      expect(commands.archive).not.toHaveBeenCalled();
      expect(await request.submit("stop_and_archive")).toBeNull();
      return "stop_and_archive";
    });
    const selected = [owner, child].map((thread) => ({
      threadRef: { environmentId: thread.environmentId, threadId: thread.id },
      threadKey: `${thread.environmentId}:${thread.id}`,
    }));
    const outcome = await useThreadActions().archiveThreads(selected);
    expect(outcome?.mutationFailure).toBeNull();
    expect(outcome?.archivedThreadKeys).toEqual(selected.map(({ threadKey }) => threadKey));
    expect(archiveFamilyLoad).toHaveBeenCalledTimes(2);
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: owner.id,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [child.id],
      },
    });
  });

  it("preserves a failed standalone archive attempt without treating it as active work", async () => {
    const owner = makeThreadFixture({
      id: target.threadId,
      environmentId: target.environmentId,
      archivePending: {
        threadId: target.threadId,
        commandId: CommandId.make("failed-standalone-archive"),
        status: "failed",
      },
    });
    familyState.threads = [owner];
    expect(await archive(true)).toBeNull();
    expect(archiveDialog).not.toHaveBeenCalled();
    expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: owner.id,
        childDisposition: "archive_if_idle",
        expectedChildThreadIds: [],
        expectedArchiveCommandId: owner.archivePending!.commandId,
      },
    });
  });

  it("cancels a working standalone thread without dispatching archive or presenting Undo", async () => {
    familyState.threads = [workingRoot()];
    archiveDialog.mockResolvedValue(null);
    expect((await archive(false))?._tag).toBe("Failure");
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(commands.archive).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice).toBeNull();
  });

  it("archives the authoritative idle owner despite locally running state", async () => {
    const local = workingRoot();
    familyState.threads = [local];
    archiveFamilyLoad.mockResolvedValue({ _tag: "Success", value: [{ ...local, runtime: null }] });
    expect((await archive(false))?._tag).toBe("Success");
    expect(archiveDialog).not.toHaveBeenCalled();
    expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        childDisposition: "archive_if_idle",
        expectedChildThreadIds: [],
      },
    });
  });

  it.each([
    ["missing", false],
    ["missing", true],
    ["persistent", false],
    ["persistent", true],
  ] as const)("blocks archive when the authoritative owner is %s (bulk=%s)", async (kind, bulk) => {
    const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
    familyState.threads = [owner];
    archiveFamilyLoad.mockResolvedValue({
      _tag: "Success",
      value: kind === "missing" ? [] : [{ ...owner, persistent: true }],
    });
    expect((await archive(bulk))?._tag).toBe("Failure");
    expect(archiveDialog).not.toHaveBeenCalled();
    expect(commands.archive).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "archives a finished, read family without stop consent (genericConfirm=%s)",
    async (genericConfirm) => {
      familyState.confirmArchive = genericConfirm;
      const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = childOf(owner);
      familyState.threads = [owner, child];
      await archive(false);
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(archiveConfirm).toHaveBeenCalledTimes(genericConfirm ? 1 : 0);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  it.each([false, true])(
    "keeps a new activity rejection visible without granting stop consent (bulk=%s)",
    async (bulk) => {
      const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = childOf(owner);
      familyState.threads = [owner, child];
      commands.archive.mockResolvedValue({
        _tag: "Failure",
        cause: Cause.fail(new Error("Family activity changed; confirm again")),
      });
      expect((await archive(bulk))?._tag).toBe("Failure");
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      });
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(useThreadUndoNotice.getState().notice).toBeNull();
    },
  );

  it.each([false, true])(
    "confirms unread completed replies without stopping work (bulk=%s)",
    async (bulk) => {
      const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = {
        ...childOf(owner),
        latestRun: {
          runId: RunId.make("completed-run"),
          status: "completed" as const,
          requestedAt: null,
          startedAt: null,
          completedAt: "2026-01-01T00:01:00.000Z",
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-01-01T00:00:00.000Z",
      };
      familyState.threads = [owner, child];
      archiveDialog.mockImplementation(async (request) => {
        expect(request.family.activeThreadIds).toEqual([]);
        expect(request.family.unreadThreadIds).toEqual([child.id]);
        expect(commands.archive).not.toHaveBeenCalled();
        expect(await request.submit("archive_after_review")).toBeNull();
        return "archive_after_review";
      });
      await archive(bulk);
      expect(archiveDialog).toHaveBeenCalledOnce();
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: owner.id,
          childDisposition: "archive_after_review",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  it("archives retained failed history without asking to stop it", async () => {
    const owner = workingRoot();
    familyState.threads = [{ ...owner, runtime: { ...owner.runtime!, status: "failed" } }];
    expect((await archive(false))?._tag).toBe("Success");
    expect(archiveDialog).not.toHaveBeenCalled();
    expect(commands.archive).toHaveBeenCalledOnce();
  });

  function seedFamily() {
    const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
    const child = { ...childOf(owner), hasPendingUserInput: true };
    const nested = childOf(child, "nested");
    familyState.threads = [owner, child, nested];
    return { owner, child, nested };
  }

  it("includes recursive descendants and offers Undo only after the archive succeeds", async () => {
    const { child, nested } = seedFamily();
    archiveDialog.mockImplementation(async (request) => {
      expect(commands.archive).not.toHaveBeenCalled();
      expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
        child.id,
        nested.id,
      ]);
      expect(await request.submit("stop_and_archive")).toBeNull();
      return "stop_and_archive";
    });
    await archive(false);
    expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [child.id, nested.id],
      },
    });
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
  });

  it("closes a failed family action and preserves its original error without rereading", async () => {
    seedFamily();
    const error = new Error("Shutdown failed");
    commands.archive.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(error) });
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("stop_and_archive")).toBe("Shutdown failed");
      return null;
    });
    const result = await archive(false);
    expect(result?._tag).toBe("Failure");
    if (result?._tag !== "Failure") throw new Error("Expected shutdown failure");
    expect(Cause.squash(result.cause)).toBe(error);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(archiveFamilyLoad).toHaveBeenCalledOnce();
    expect(commands.archive).toHaveBeenCalledOnce();
  });

  it("requires fresh explicit consent on the next action after membership changes", async () => {
    const { owner, child, nested } = seedFamily();
    const added = childOf(owner, "added-child");
    commands.archive.mockImplementationOnce(async () => {
      familyState.threads.push(added);
      return { _tag: "Failure", cause: Cause.fail(new Error("Family changed")) };
    });
    archiveDialog
      .mockImplementationOnce(async (request) => {
        expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
          child.id,
          nested.id,
        ]);
        expect(await request.submit("stop_and_archive")).toBe("Family changed");
        return null;
      })
      .mockImplementationOnce(async (request) => {
        expect(commands.archive).toHaveBeenCalledOnce();
        expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
          child.id,
          nested.id,
          added.id,
        ]);
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
    expect((await archive(false))?._tag).toBe("Failure");
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(commands.archive).toHaveBeenCalledOnce();
    expect((await archive(false))?._tag).toBe("Success");
    expect(archiveDialog).toHaveBeenCalledTimes(2);
    expect(archiveFamilyLoad).toHaveBeenCalledTimes(2);
    expect(commands.archive).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [child.id, nested.id, added.id],
      },
    });
  });

  it.each([false, true])(
    "reads hidden intermediate owners before archive (bulk=%s)",
    async (bulk) => {
      const { owner, child, nested } = seedFamily();
      const inactiveOwner = { ...child, archivedAt: "2026-01-01T00:00:00.000Z" };
      const liveNested = { ...nested, hasPendingApprovals: true };
      familyState.threads = [liveNested];
      archiveFamilyLoad.mockResolvedValue({
        _tag: "Success",
        value: [owner, inactiveOwner, liveNested],
      });
      archiveDialog.mockImplementation(async (request) => {
        expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
          nested.id,
        ]);
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      await archive(bulk);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [nested.id],
        },
      });
    },
  );

  it.each([false, true])("blocks mutations when the family read fails (bulk=%s)", async (bulk) => {
    archiveFamilyLoad.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Family unavailable")),
    });
    expect((await archive(bulk))?._tag).toBe("Failure");
    expect(commands.archive).not.toHaveBeenCalled();
    expect(archiveDialog).not.toHaveBeenCalled();
  });

  it("reads every bulk family before dispatching any participant", async () => {
    archiveFamilyLoad
      .mockResolvedValueOnce({
        _tag: "Success",
        value: [makeThreadFixture({ id: target.threadId, environmentId: target.environmentId })],
      })
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("Second family unavailable")),
      });
    const outcome = await useThreadActions().archiveThreads([
      { threadRef: target, threadKey: "undo-env:thread" },
      { threadRef: { ...target, threadId: ThreadId.make("second") }, threadKey: "undo-env:second" },
    ]);
    expect(outcome?.mutationFailure?._tag).toBe("Failure");
    expect(archiveFamilyLoad).toHaveBeenCalledTimes(2);
    expect(commands.archive).not.toHaveBeenCalled();
    expect(archiveDialog).not.toHaveBeenCalled();
  });
});

describe("bulk archive progress", () => {
  function seedBulkFamilies(retry = false) {
    const second = { ...target, threadId: ThreadId.make("second") };
    const roots = [target, second].map((ref) =>
      makeThreadFixture({ id: ref.threadId, environmentId: ref.environmentId }),
    );
    const children = roots.map((root) =>
      makeThreadFixture({
        id: ThreadId.make(`${root.id}:child`),
        environmentId: root.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
        hasPendingUserInput: true,
      }),
    );
    if (retry) {
      const owner = roots[0]!;
      const child = children[0]!;
      const pending = {
        threadId: owner.id,
        commandId: CommandId.make("failed-archive"),
        childDisposition: "stop_and_archive" as const,
        childThreadIds: [child.id],
        archiveThreadIds: [owner.id, child.id],
        promoteThreadIds: [],
        status: "failed" as const,
      };
      roots[0] = { ...owner, archivedAt: "2026-01-01T00:00:00.000Z", archivePending: pending };
      children[0] = {
        ...child,
        archivePending: {
          threadId: pending.threadId,
          commandId: pending.commandId,
          status: pending.status,
        },
      };
    }
    familyState.threads = [...roots, ...children];
    archiveFamilyLoad.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: familyState.threads.filter(
        (thread) => thread.id === input.threadId || thread.lineage.rootThreadId === input.threadId,
      ),
    }));
    let secondAttempts = 0;
    commands.archive.mockImplementation(async ({ input }) => {
      if (input.threadId === target.threadId) {
        const root = familyState.threads.find((thread) => thread.id === target.threadId)!;
        if (root.archivedAt !== null && root.archivePending?.status !== "failed")
          return { _tag: "Failure", cause: Cause.fail(new Error("The subagents changed")) };
        familyState.threads = familyState.threads.map((thread) => {
          if (thread.id === target.threadId)
            return { ...thread, archivedAt: "2026-01-01T00:00:00.000Z", archivePending: null };
          if (thread.lineage.parentThreadId !== target.threadId) return thread;
          return { ...thread, archivedAt: "2026-01-01T00:00:00.000Z", archivePending: null };
        });
        return { _tag: "Success", value: undefined };
      }
      if (++secondAttempts === 1)
        return { _tag: "Failure", cause: Cause.fail(new Error("Second family shutdown failed")) };
      return { _tag: "Success", value: undefined };
    });
    return {
      selected: [target, second].map((threadRef) => ({
        threadRef,
        threadKey: `${threadRef.environmentId}:${threadRef.threadId}`,
      })),
      children,
      second,
    };
  }

  it("retains completed families after a failure and retries only the remaining fresh family", async () => {
    const { selected: roots, children, second } = seedBulkFamilies();
    const completedChild = children[0]!;
    const childEntry = {
      threadKey: `${completedChild.environmentId}:${completedChild.id}`,
      threadRef: { environmentId: completedChild.environmentId, threadId: completedChild.id },
    };
    const added = makeThreadFixture({
      id: ThreadId.make("added-child"),
      environmentId: second.environmentId,
      lineage: {
        rootThreadId: second.threadId,
        parentThreadId: second.threadId,
        relationshipToParent: "subagent",
      },
    });
    const archive = commands.archive.getMockImplementation()!;
    commands.archive.mockImplementation(async (request) => {
      const result = await archive(request);
      if (result._tag === "Failure") familyState.threads.push(added);
      return result;
    });
    archiveDialog
      .mockImplementationOnce(async (request) => {
        expect(archiveFamilyLoad).toHaveBeenCalledTimes(3);
        expect(commands.archive).not.toHaveBeenCalled();
        expect(await request.submit("stop_and_archive")).toBe("Second family shutdown failed");
        return null;
      })
      .mockImplementationOnce(async (request) => {
        expect(request.family.children.map((thread: { id: string }) => thread.id)).toEqual([
          children[1]!.id,
          added.id,
        ]);
        expect(commands.archive).toHaveBeenCalledTimes(2);
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
    const actions = useThreadActions();
    const outcome = await actions.archiveThreads([childEntry, ...roots]);
    expect(outcome?.archivedThreadKeys).toEqual([childEntry.threadKey, roots[0]!.threadKey]);
    expect(outcome?.mutationFailure?._tag).toBe("Failure");
    if (outcome?.mutationFailure?._tag !== "Failure")
      throw new Error("Expected the second archive failure");
    expect(Cause.squash(outcome.mutationFailure.cause)).toMatchObject({
      message: "Second family shutdown failed",
    });
    expect(commands.archive).toHaveBeenCalledTimes(2);
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(archiveFamilyLoad).toHaveBeenCalledTimes(3);

    const retried = await actions.archiveThreads([roots[1]!]);
    expect(retried?.archivedThreadKeys).toEqual([roots[1]!.threadKey]);
    expect(retried?.mutationFailure).toBeNull();
    expect(commands.archive.mock.calls.map(([request]) => request.input)).toEqual([
      {
        threadId: target.threadId,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [children[0]!.id],
      },
      {
        threadId: second.threadId,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [children[1]!.id],
      },
      {
        threadId: second.threadId,
        childDisposition: "stop_and_archive",
        expectedChildThreadIds: [children[1]!.id, added.id],
      },
    ]);
    expect(archiveDialog).toHaveBeenCalledTimes(2);
    expect(archiveFamilyLoad).toHaveBeenCalledTimes(4);
  });

  it("leaves the open descendant after bulk archive and restores its family with Undo", async () => {
    const { selected, children } = seedBulkFamilies();
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: children[0]!.id,
    };
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("stop_and_archive")).toBeNull();
      return "stop_and_archive";
    });
    const outcome = await useThreadActions().archiveThreads([selected[0]!]);
    expect(outcome?.mutationFailure).toBeNull();
    expect(newThread).toHaveBeenCalledOnce();
    expect(archiveDialog).toHaveBeenCalledOnce();
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it.each([false, true])(
    "removes original failed child selections after partial progress (owner selected=%s)",
    async (selectOwner) => {
      const { selected: roots, children } = seedBulkFamilies(true);
      const child = children[0]!;
      const childEntry = {
        threadKey: `${child.environmentId}:${child.id}`,
        threadRef: { environmentId: child.environmentId, threadId: child.id },
      };
      const selected = [childEntry, ...(selectOwner ? [roots[0]!] : []), roots[1]!];
      for (const entry of selected)
        useThreadSelectionStore.getState().toggleThread(entry.threadKey);
      useThreadSelectionStore.getState().setAnchor(childEntry.threadKey);
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit("stop_and_archive")).toBe("Second family shutdown failed");
        return null;
      });
      const outcome = await useThreadActions().archiveThreads(selected);
      expect(outcome?.archivedThreadKeys).toEqual([
        childEntry.threadKey,
        ...(selectOwner ? [roots[0]!.threadKey] : []),
      ]);
      expect(outcome?.mutationFailure?._tag).toBe("Failure");
      useThreadSelectionStore.getState().removeFromSelection(outcome!.archivedThreadKeys);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        roots[1]!.threadKey,
      ]);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBeNull();
      expect(familyState.threads.find((thread) => thread.id === child.id)).toMatchObject({
        archivedAt: "2026-01-01T00:00:00.000Z",
        lineage: { parentThreadId: target.threadId },
      });
      expect(commands.archive.mock.calls.map(([request]) => request.input.threadId)).toEqual([
        target.threadId,
        roots[1]!.threadRef.threadId,
      ]);
      expect(commands.archive.mock.calls[0]![0].input.expectedArchiveCommandId).toBe(
        "failed-archive",
      );
      expect(archiveFamilyLoad).toHaveBeenCalledTimes(2);
    },
  );

  it("cancels bulk confirmation without dispatching any family", async () => {
    const { selected } = seedBulkFamilies();
    archiveDialog.mockResolvedValue(null);
    expect(await useThreadActions().archiveThreads(selected)).toBeNull();
    expect(commands.archive).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice).toBeNull();
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

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.snoozeThread(target, new Date(Date.now() + 60_000).toISOString());
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});
