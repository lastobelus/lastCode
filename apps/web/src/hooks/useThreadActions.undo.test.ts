import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { makeThreadFixture } from "../test-fixtures";

const familyState = vi.hoisted(() => ({
  threads: [] as ReturnType<typeof makeThreadFixture>[],
  archiveSupport: true as boolean | undefined,
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
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
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
  familyState.threads = [];
  familyState.archiveSupport = true;
  familyState.unsupportedEnvironments.clear();
  newThread.mockReset().mockResolvedValue(undefined);
  archiveDialog.mockReset();
  archiveFamilyQuery.mockReset().mockImplementation(async ({ environmentId, input }) => ({
    _tag: "Success",
    value: [
      makeThreadFixture({ id: input.threadId, environmentId }),
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
  function seedBulkFamilies() {
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
        if (root.archivedAt !== null)
          return { _tag: "Failure", cause: Cause.fail(new Error("The subagents changed")) };
        familyState.threads = familyState.threads.map((thread) => {
          if (thread.id === target.threadId)
            return { ...thread, archivedAt: "2026-01-01T00:00:00.000Z" };
          if (thread.lineage.parentThreadId !== target.threadId) return thread;
          return input.childDisposition === "promote"
            ? { ...thread, lineage: { ...thread.lineage, independent: true } }
            : { ...thread, archivedAt: "2026-01-01T00:00:00.000Z" };
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
      expect(archiveFamilyQuery).toHaveBeenCalledTimes(2);
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
