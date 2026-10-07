import { CommandId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const archiveFamilyQuery = vi.hoisted(() => vi.fn());
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
  useAtomQueryRunner: (family: unknown) =>
    family === threadEnvironment.archiveFamilyAtom ? archiveFamilyQuery : vi.fn(),
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
  archiveFamilyQuery.mockReset().mockImplementation(async ({ environmentId, input }) => ({
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
        message:
          "Update this environment's server before archiving threads and their subagents safely.",
      });
      expect(archiveFamilyQuery).not.toHaveBeenCalled();
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
    expect(archiveFamilyQuery).not.toHaveBeenCalled();
    expect(commands.archive).not.toHaveBeenCalled();
  });
});

describe("stranded archive retry navigation", () => {
  it.each([
    { source: "provider", choice: "stop_and_archive", route: "child", leaves: true, nested: false },
    { source: "mcp", choice: "promote", route: "child", leaves: false, nested: false },
    { source: "mcp", choice: "promote", route: "owner", leaves: true, nested: false },
    { source: "provider", choice: "promote", route: "child", leaves: false, nested: true },
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
      archiveFamilyQuery.mockResolvedValue({ _tag: "Success", value: [owner, ...branch, child] });
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
        input: { threadId: ownerId, childDisposition: choice, expectedChildThreadIds },
      });
      expect(newThread).toHaveBeenCalledTimes(leaves ? 1 : 0);
      await currentUndo()();
      expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: { threadId: ownerId },
      });
    },
  );
});

describe("archive family confirmation", () => {
  function workingRoot() {
    return makeThreadFixture({
      id: target.threadId,
      environmentId: target.environmentId,
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "codex",
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  it.each([
    [false, "stop_and_archive"],
    [false, "promote"],
    [true, "stop_and_archive"],
    [true, "promote"],
  ] as const)(
    "confirms a working owner with idle children (bulk=%s, choice=%s)",
    async (bulk, choice) => {
      const root = workingRoot();
      const child = makeThreadFixture({
        id: ThreadId.make("idle-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [root]; // The visible snapshot cannot establish ownership.
      archiveFamilyQuery.mockResolvedValue({ _tag: "Success", value: [root, child] });
      archiveDialog.mockImplementation(async (request) => {
        expect(commands.archive).not.toHaveBeenCalled();
        expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([child.id]);
        expect(request.activeChildren).toEqual([]);
        expect(await request.submit(choice)).toBeNull();
        return choice;
      });
      const actions = useThreadActions();
      if (bulk) await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]);
      else await actions.archiveThread(target);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(1);
      expect(archiveDialog).toHaveBeenCalledTimes(1);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: { threadId: root.id, childDisposition: choice, expectedChildThreadIds: [child.id] },
      });
    },
  );

  it.each(["none", "fork", "independent"] as const)(
    "refuses working standalone archive after reading family (%s)",
    async (kind) => {
      const root = workingRoot();
      const unrelated = makeThreadFixture({
        id: ThreadId.make("unowned-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: kind === "fork" ? "fork" : "subagent",
          ...(kind === "independent" ? { independent: true } : {}),
        },
      });
      familyState.threads = [root];
      archiveFamilyQuery.mockResolvedValue({
        _tag: "Success",
        value: kind === "none" ? [root] : [root, unrelated],
      });
      expect((await useThreadActions().archiveThread(target))._tag).toBe("Failure");
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(1);
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(commands.archive).not.toHaveBeenCalled();
    },
  );

  it("cancels a working owner family without stopping any work", async () => {
    const root = workingRoot();
    const child = makeThreadFixture({
      id: ThreadId.make("child"),
      environmentId: target.environmentId,
      lineage: { rootThreadId: root.id, parentThreadId: root.id, relationshipToParent: "subagent" },
    });
    familyState.threads = [root];
    archiveFamilyQuery.mockResolvedValue({ _tag: "Success", value: [root, child] });
    archiveDialog.mockResolvedValue(null);
    expect((await useThreadActions().archiveThread(target))._tag).toBe("Failure");
    expect(archiveDialog).toHaveBeenCalledTimes(1);
    expect(commands.archive).not.toHaveBeenCalled();
  });

  it.each(["stop_and_archive", "promote", null] as const)(
    "confirms the authoritative working owner despite a locally idle snapshot: %s",
    async (choice) => {
      const owner = { ...workingRoot(), title: "Authoritative title" };
      const child = makeThreadFixture({
        id: ThreadId.make("idle-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [{ ...owner, runtime: null, title: "Stale title" }];
      archiveFamilyQuery.mockResolvedValue({ _tag: "Success", value: [owner, child] });
      archiveDialog.mockImplementation(async (request) => {
        expect(request.title).toContain("Authoritative title");
        expect(commands.archive).not.toHaveBeenCalled();
        if (choice !== null) expect(await request.submit(choice)).toBeNull();
        return choice;
      });
      const result = await useThreadActions().archiveThread(target);
      expect(archiveDialog).toHaveBeenCalledTimes(1);
      expect(result._tag).toBe(choice === null ? "Failure" : "Success");
      if (choice === null) expect(commands.archive).not.toHaveBeenCalled();
      else
        expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
          environmentId: target.environmentId,
          input: {
            threadId: owner.id,
            childDisposition: choice,
            expectedChildThreadIds: [child.id],
          },
        });
    },
  );

  it("archives the authoritative idle standalone owner despite locally running state", async () => {
    const local = workingRoot();
    familyState.threads = [local];
    archiveFamilyQuery.mockResolvedValue({ _tag: "Success", value: [{ ...local, runtime: null }] });
    expect((await useThreadActions().archiveThread(target))._tag).toBe("Success");
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

  it.each(["missing", "persistent"] as const)(
    "blocks archive when the authoritative owner is %s",
    async (kind) => {
      const owner = { ...workingRoot(), runtime: null };
      familyState.threads = [owner];
      archiveFamilyQuery.mockResolvedValue({
        _tag: "Success",
        value: kind === "missing" ? [] : [{ ...owner, persistent: true }],
      });
      expect((await useThreadActions().archiveThread(target))._tag).toBe("Failure");
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(commands.archive).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "idle family archive never grants stop consent (bulk=%s, genericConfirm=%s)",
    async (bulk, genericConfirm) => {
      familyState.confirmArchive = genericConfirm;
      const root = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = makeThreadFixture({
        id: ThreadId.make("idle-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [root, child];
      const actions = useThreadActions();
      if (bulk) await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]);
      else await actions.archiveThread(target);
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(archiveConfirm).toHaveBeenCalledTimes(genericConfirm ? 1 : 0);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(1);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: root.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  it.each([false, true])(
    "keeps an idle archive rejection visible without granting stop consent (bulk=%s)",
    async (bulk) => {
      const root = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const child = makeThreadFixture({
        id: ThreadId.make("idle-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [root, child];
      commands.archive.mockResolvedValue({
        _tag: "Failure",
        cause: Cause.fail(new Error("Family activity changed; confirm again")),
      });
      const actions = useThreadActions();
      if (bulk) {
        const outcome = await actions.archiveThreads([
          { threadRef: target, threadKey: "undo-env:thread" },
        ]);
        expect(outcome?.mutationFailure?._tag).toBe("Failure");
        expect(outcome?.archivedThreadKeys).toEqual([]);
      } else expect((await actions.archiveThread(target))._tag).toBe("Failure");
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: root.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      });
      expect(archiveDialog).not.toHaveBeenCalled();
      expect(useThreadUndoNotice.getState().notice).toBeNull();
    },
  );

  it.each([
    [false, "question"],
    [true, "question"],
    [false, "failed"],
    [true, "failed"],
  ] as const)(
    "offers explicit choices for owner attention with idle children (bulk=%s, attention=%s)",
    async (bulk, attention) => {
      const root = {
        ...workingRoot(),
        runtime:
          attention === "failed" ? { ...workingRoot().runtime!, status: "failed" as const } : null,
        hasPendingUserInput: attention === "question",
      };
      const child = makeThreadFixture({
        id: ThreadId.make("idle-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
      });
      familyState.threads = [root, child];
      archiveDialog.mockImplementation(async (request) => {
        expect(request.activeChildren).toEqual([]);
        expect(commands.archive).not.toHaveBeenCalled();
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      const actions = useThreadActions();
      if (bulk) await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]);
      else await actions.archiveThread(target);
      expect(archiveDialog).toHaveBeenCalledTimes(1);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: root.id,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [child.id],
        },
      });
    },
  );

  function seedFamily() {
    const child = makeThreadFixture({
      id: ThreadId.make("child"),
      environmentId: target.environmentId,
      lineage: {
        parentThreadId: target.threadId,
        rootThreadId: target.threadId,
        relationshipToParent: "subagent",
      },
      attention: { kind: "question", raisedAt: "2026-01-01T00:00:00.000Z" },
    });
    const nested = makeThreadFixture({
      id: ThreadId.make("nested"),
      environmentId: target.environmentId,
      lineage: {
        parentThreadId: child.id,
        rootThreadId: target.threadId,
        relationshipToParent: "subagent",
      },
    });
    familyState.threads = [child, nested];
    return { child, nested };
  }

  it("cancels without dispatching archive or presenting Undo", async () => {
    seedFamily();
    archiveDialog.mockResolvedValue(null);
    const result = await useThreadActions().archiveThread(target);
    expect(result._tag).toBe("Failure");
    expect(commands.archive).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice).toBeNull();
  });

  it.each(["stop_and_archive", "promote"] as const)(
    "requires %s consent and includes recursive descendants",
    async (choice) => {
      const { child, nested } = seedFamily();
      archiveDialog.mockImplementation(async (request) => {
        expect(commands.archive).not.toHaveBeenCalled();
        expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([
          child.id,
          nested.id,
        ]);
        expect(await request.submit(choice)).toBeNull();
        return choice;
      });
      await useThreadActions().archiveThread(target);
      expect(commands.archive).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          childDisposition: choice,
          expectedChildThreadIds: [child.id, nested.id],
        },
      });
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    },
  );

  it("keeps failed shutdown in the modal and offers no Undo", async () => {
    seedFamily();
    commands.archive.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Shutdown failed")),
    });
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("stop_and_archive")).toContain("Shutdown failed");
      return null;
    });
    await useThreadActions().archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
  });

  it("retries an unchanged family in the same modal without losing its failure", async () => {
    seedFamily();
    commands.archive.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Shutdown failed")),
    });
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("stop_and_archive")).toBe("Shutdown failed");
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      expect(await request.submit("stop_and_archive")).toBeNull();
      return "stop_and_archive";
    });
    expect((await useThreadActions().archiveThread(target))._tag).toBe("Success");
    expect(archiveDialog).toHaveBeenCalledOnce();
    expect(archiveFamilyQuery).toHaveBeenCalledTimes(2);
    expect(commands.archive).toHaveBeenCalledTimes(2);
  });

  it.each([
    "added",
    "removed",
    "protected",
    "native",
    "reparented",
    "persistent owner",
    "missing owner",
    "refresh failed",
  ] as const)(
    "closes obsolete consent after a failed archive when the family is %s",
    async (change) => {
      const { child, nested } = seedFamily();
      const owner = makeThreadFixture({ id: target.threadId, environmentId: target.environmentId });
      const displayedChild =
        change === "reparented"
          ? { ...child, source: { ...child.source, creationSource: "provider" as const } }
          : child;
      const original = [owner, displayedChild, nested];
      const added = makeThreadFixture({
        id: ThreadId.make("added-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: "subagent",
        },
      });
      const changed =
        change === "added"
          ? [...original, added]
          : change === "removed"
            ? [owner, child]
            : change === "protected"
              ? [owner, { ...child, persistent: true }, nested]
              : change === "native"
                ? [
                    owner,
                    { ...child, source: { ...child.source, creationSource: "provider" } },
                    nested,
                  ]
                : change === "reparented"
                  ? [
                      owner,
                      { ...child, source: { ...child.source, creationSource: "provider" } },
                      { ...nested, lineage: { ...nested.lineage, parentThreadId: owner.id } },
                    ]
                  : change === "persistent owner"
                    ? [{ ...owner, persistent: true }, child, nested]
                    : change === "missing owner"
                      ? [child, nested]
                      : original;
      archiveFamilyQuery
        .mockResolvedValueOnce({ _tag: "Success", value: original })
        .mockResolvedValueOnce(
          change === "refresh failed"
            ? { _tag: "Failure", cause: Cause.fail(new Error("Family unavailable")) }
            : { _tag: "Success", value: changed },
        );
      const error = new Error("Archive rejected");
      commands.archive.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(error) });
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit("stop_and_archive")).toEqual({
          error: "Archive rejected",
          close: true,
        });
        return null; // The dialog resolves automatically after obsolete choices close.
      });
      const result = await useThreadActions().archiveThread(target);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected the archive rejection");
      expect(Cause.squash(result.cause)).toBe(error);
      expect(archiveDialog).toHaveBeenCalledOnce();
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(2);
      expect(commands.archive).toHaveBeenCalledOnce();
      expect(useThreadUndoNotice.getState().notice).toBeNull();
    },
  );

  it.each(["stop_and_archive", "promote"] as const)(
    "requires fresh explicit %s consent on the next action after membership changes",
    async (choice) => {
      const { child, nested } = seedFamily();
      const added = makeThreadFixture({
        id: ThreadId.make("added-child"),
        environmentId: target.environmentId,
        lineage: {
          rootThreadId: target.threadId,
          parentThreadId: target.threadId,
          relationshipToParent: "subagent",
        },
      });
      commands.archive.mockImplementationOnce(async () => {
        familyState.threads.push(added);
        return { _tag: "Failure", cause: Cause.fail(new Error("Family changed")) };
      });
      archiveDialog
        .mockImplementationOnce(async (request) => {
          expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([
            child.id,
            nested.id,
          ]);
          expect(await request.submit("stop_and_archive")).toEqual({
            error: "Family changed",
            close: true,
          });
          return null;
        })
        .mockImplementationOnce(async (request) => {
          expect(commands.archive).toHaveBeenCalledOnce();
          expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([
            child.id,
            nested.id,
            added.id,
          ]);
          expect(await request.submit(choice)).toBeNull();
          return choice;
        });
      const actions = useThreadActions();
      expect((await actions.archiveThread(target))._tag).toBe("Failure");
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      expect(commands.archive).toHaveBeenCalledOnce();
      expect((await actions.archiveThread(target))._tag).toBe("Success");
      expect(archiveDialog).toHaveBeenCalledTimes(2);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(3);
      expect(commands.archive).toHaveBeenLastCalledWith({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          childDisposition: choice,
          expectedChildThreadIds: [child.id, nested.id, added.id],
        },
      });
    },
  );

  it.each([false, true])(
    "reads hidden intermediate owners before archive (bulk=%s)",
    async (bulk) => {
      const { child, nested } = seedFamily();
      const inactiveOwner = { ...child, archivedAt: "2026-01-01T00:00:00.000Z" };
      const liveNested = { ...nested, hasPendingApprovals: true };
      familyState.threads = [liveNested];
      archiveFamilyQuery.mockResolvedValue({
        _tag: "Success",
        value: [
          makeThreadFixture({ id: target.threadId, environmentId: target.environmentId }),
          inactiveOwner,
          liveNested,
        ],
      });
      archiveDialog.mockImplementation(async (request) => {
        expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([nested.id]);
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      const actions = useThreadActions();
      if (bulk) await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]);
      else await actions.archiveThread(target);
      expect(archiveFamilyQuery).toHaveBeenCalledWith({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
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
    archiveFamilyQuery.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Family unavailable")),
    });
    const actions = useThreadActions();
    const result = bulk
      ? (await actions.archiveThreads([{ threadRef: target, threadKey: "undo-env:thread" }]))
          ?.mutationFailure
      : await actions.archiveThread(target);
    expect(result?._tag).toBe("Failure");
    expect(commands.archive).not.toHaveBeenCalled();
    expect(archiveDialog).not.toHaveBeenCalled();
  });

  it("reads every bulk family before dispatching any participant", async () => {
    archiveFamilyQuery
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
    expect(archiveFamilyQuery).toHaveBeenCalledTimes(2);
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
        attention: { kind: "question", raisedAt: "2026-01-01T00:00:00.000Z" },
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
    archiveFamilyQuery.mockImplementation(async ({ input }) => ({
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
          return input.childDisposition === "promote"
            ? { ...thread, lineage: { ...thread.lineage, independent: true }, archivePending: null }
            : { ...thread, archivedAt: "2026-01-01T00:00:00.000Z", archivePending: null };
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

  it.each(["stop_and_archive", "promote"] as const)(
    "retains completed %s families and retries only the unresolved family",
    async (firstChoice) => {
      const { selected, children, second } = seedBulkFamilies();
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit(firstChoice)).toContain("Second family shutdown failed");
        expect(await request.submit("stop_and_archive")).toBeNull();
        return "stop_and_archive";
      });
      const outcome = await useThreadActions().archiveThreads(selected);
      expect(outcome?.archivedThreadKeys).toEqual(selected.map((entry) => entry.threadKey));
      expect(outcome?.mutationFailure).toBeNull();
      expect(commands.archive.mock.calls.map(([request]) => request.input)).toEqual([
        {
          threadId: target.threadId,
          childDisposition: firstChoice,
          expectedChildThreadIds: [children[0]!.id],
        },
        {
          threadId: second.threadId,
          childDisposition: firstChoice,
          expectedChildThreadIds: [children[1]!.id],
        },
        {
          threadId: second.threadId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [children[1]!.id],
        },
      ]);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["stop_and_archive", "promote"] as const)(
    "handles the open descendant view after a bulk %s choice",
    async (choice) => {
      const { selected, children } = seedBulkFamilies();
      router.state.matches[0]!.params = {
        environmentId: target.environmentId,
        threadId: children[0]!.id,
      };
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit(choice)).toBeNull();
        return choice;
      });
      await useThreadActions().archiveThreads([selected[0]!]);
      expect(newThread).toHaveBeenCalledTimes(choice === "stop_and_archive" ? 1 : 0);
      expect(archiveDialog).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["stop_and_archive", false],
    ["promote", false],
    ["stop_and_archive", true],
    ["promote", true],
  ] as const)(
    "closes stale bulk consent after partial %s progress (refresh fails=%s)",
    async (choice, refreshFails) => {
      const { selected: roots, children, second } = seedBulkFamilies();
      const completedChild = children[0]!;
      const childEntry = {
        threadKey: `${completedChild.environmentId}:${completedChild.id}`,
        threadRef: { environmentId: completedChild.environmentId, threadId: completedChild.id },
      };
      const selected = [childEntry, ...roots];
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
        if (result._tag === "Failure") {
          familyState.threads.push(added);
          if (refreshFails)
            archiveFamilyQuery.mockResolvedValueOnce({
              _tag: "Failure",
              cause: Cause.fail(new Error("Family unavailable")),
            });
        }
        return result;
      });
      archiveDialog
        .mockImplementationOnce(async (request) => {
          // Even selected descendants are queried before the first mutation.
          expect(archiveFamilyQuery).toHaveBeenCalledTimes(3);
          expect(commands.archive).not.toHaveBeenCalled();
          expect(await request.submit(choice)).toEqual({
            error: "Second family shutdown failed",
            close: true,
          });
          return null;
        })
        .mockImplementationOnce(async (request) => {
          expect(request.children.map((thread: { id: string }) => thread.id)).toEqual([
            children[1]!.id,
            added.id,
          ]);
          expect(commands.archive).toHaveBeenCalledTimes(2);
          expect(await request.submit("stop_and_archive")).toBeNull();
          return "stop_and_archive";
        });
      const actions = useThreadActions();
      const outcome = await actions.archiveThreads(selected);
      expect(outcome?.archivedThreadKeys).toEqual([
        ...(choice === "stop_and_archive" ? [childEntry.threadKey] : []),
        roots[0]!.threadKey,
      ]);
      expect(outcome?.mutationFailure?._tag).toBe("Failure");
      if (outcome?.mutationFailure?._tag !== "Failure")
        throw new Error("Expected the second archive failure");
      expect(Cause.squash(outcome.mutationFailure.cause)).toMatchObject({
        message: "Second family shutdown failed",
      });
      expect(commands.archive).toHaveBeenCalledTimes(2);
      expect(archiveDialog).toHaveBeenCalledOnce();
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(4);
      const retried = await actions.archiveThreads([roots[1]!]);
      expect(retried?.archivedThreadKeys).toEqual([roots[1]!.threadKey]);
      expect(retried?.mutationFailure).toBeNull();
      expect(commands.archive.mock.calls.map(([request]) => request.input.threadId)).toEqual([
        target.threadId,
        second.threadId,
        second.threadId,
      ]);
      expect(commands.archive).toHaveBeenLastCalledWith({
        environmentId: second.environmentId,
        input: {
          threadId: second.threadId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [children[1]!.id, added.id],
        },
      });
      expect(archiveDialog).toHaveBeenCalledTimes(2);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(5);
    },
  );

  it("retains successful selection keys when the user cancels after partial progress", async () => {
    const { selected } = seedBulkFamilies();
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("promote")).toContain("Second family shutdown failed");
      return null;
    });
    const outcome = await useThreadActions().archiveThreads(selected);
    expect(outcome?.archivedThreadKeys).toEqual([selected[0]!.threadKey]);
    expect(outcome?.mutationFailure?._tag).toBe("Failure");
    expect(commands.archive).toHaveBeenCalledTimes(2);
  });

  it.each([
    [false, "stop_and_archive"],
    [false, "promote"],
    [true, "stop_and_archive"],
    [true, "promote"],
  ] as const)(
    "removes original failed child selections after partial progress (owner selected=%s, choice=%s)",
    async (selectOwner, choice) => {
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
        expect(await request.submit(choice)).toContain("Second family shutdown failed");
        return null;
      });

      const outcome = await useThreadActions().archiveThreads(selected);
      const archivedKeys = [
        ...(choice === "stop_and_archive" ? [childEntry.threadKey] : []),
        ...(selectOwner ? [roots[0]!.threadKey] : []),
      ];
      expect(outcome?.archivedThreadKeys).toEqual(archivedKeys);
      expect(outcome?.mutationFailure?._tag).toBe("Failure");
      useThreadSelectionStore.getState().removeFromSelection(outcome!.archivedThreadKeys);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        ...(choice === "promote" ? [childEntry.threadKey] : []),
        roots[1]!.threadKey,
      ]);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(
        choice === "promote" ? childEntry.threadKey : null,
      );
      const completedChild = familyState.threads.find((thread) => thread.id === child.id)!;
      expect(completedChild.archivedAt).toBe(
        choice === "stop_and_archive" ? "2026-01-01T00:00:00.000Z" : null,
      );
      expect(completedChild.lineage.independent).toBe(choice === "promote" ? true : undefined);
      expect(completedChild.lineage.parentThreadId).toBe(target.threadId);
      expect(commands.archive.mock.calls.map(([request]) => request.input.threadId)).toEqual([
        target.threadId,
        roots[1]!.threadRef.threadId,
      ]);
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps promoted selected children when a later stop retry is cancelled", async () => {
    const { selected: roots, children } = seedBulkFamilies(true);
    const child = children[0]!;
    const childEntry = {
      threadKey: `${child.environmentId}:${child.id}`,
      threadRef: { environmentId: child.environmentId, threadId: child.id },
    };
    const selected = [childEntry, ...roots];
    const archive = commands.archive.getMockImplementation()!;
    // Only the remaining family is attempted again; it never completes.
    const failure = { _tag: "Failure", cause: Cause.fail(new Error("Shutdown failed")) };
    commands.archive.mockImplementation((request) =>
      request.input.threadId === target.threadId ? archive(request) : Promise.resolve(failure),
    );
    archiveDialog.mockImplementation(async (request) => {
      expect(await request.submit("promote")).toBe("Shutdown failed");
      expect(await request.submit("stop_and_archive")).toBe("Shutdown failed");
      return null;
    });

    const outcome = await useThreadActions().archiveThreads(selected);
    expect(outcome?.archivedThreadKeys).toEqual([roots[0]!.threadKey]);
    expect(commands.archive.mock.calls.map(([request]) => request.input.threadId)).toEqual([
      target.threadId,
      roots[1]!.threadRef.threadId,
      roots[1]!.threadRef.threadId,
    ]);
    expect(familyState.threads.find((thread) => thread.id === child.id)).toMatchObject({
      archivedAt: null,
      lineage: { independent: true },
    });
  });

  it.each(["stop_and_archive", "promote"] as const)(
    "reports original descendant selections covered by a selected ancestor (%s)",
    async (choice) => {
      const { selected: roots, children } = seedBulkFamilies();
      const child = children[0]!;
      const childEntry = {
        threadKey: `${child.environmentId}:${child.id}`,
        threadRef: { environmentId: child.environmentId, threadId: child.id },
      };
      archiveDialog.mockImplementation(async (request) => {
        expect(await request.submit(choice)).toContain("Second family shutdown failed");
        return null;
      });
      const outcome = await useThreadActions().archiveThreads([childEntry, ...roots]);
      expect(outcome?.archivedThreadKeys).toEqual([
        ...(choice === "stop_and_archive" ? [childEntry.threadKey] : []),
        roots[0]!.threadKey,
      ]);
      expect(commands.archive.mock.calls.map(([request]) => request.input.threadId)).toEqual([
        target.threadId,
        roots[1]!.threadRef.threadId,
      ]);
    },
  );
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
