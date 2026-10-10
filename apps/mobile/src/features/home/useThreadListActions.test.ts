import { makeThreadShellFixture } from "../../test-fixtures";
import type { resolveThreadArchiveFamily } from "./threadArchive";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pendingOrder: null as object | null,
  dropBusy: false,
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  archiveFamily: undefined as Parameters<typeof resolveThreadArchiveFamily>[0] | undefined,
  archiveFamilyError: undefined as Error | undefined,
  archiveMutationError: undefined as Error | undefined,
  archiveFamilyReads: [] as { environmentId: string; input: { threadId: string } }[],
  archiveSupport: true as boolean | undefined,
  alertMessages: [] as string[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string };
  }[],
  dialogs: [] as { onConfirm: () => void }[],
  alerts: [] as {
    title: string;
    buttons?: { text: string; onPress?: () => void }[];
  }[],
  afterRequest: undefined as (() => void) | undefined,
  afterAlert: undefined as (() => void) | undefined,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons?: { text: string; onPress?: () => void }[]) => {
      state.alerts.push({ title, buttons });
      state.alertMessages.push(message);
      state.afterAlert?.();
    },
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (dialog: { onConfirm: () => void }) => state.dialogs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: () => {},
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    set: (_atom: string, value: boolean) => {
      state.dropBusy = value;
    },
    get: (atom: string) =>
      atom === "thread-drop-busy"
        ? state.dropBusy
        : atom === "thread-shells"
          ? state.shells
          : atom === "queued-thread-keys"
            ? new Set<string>()
            : new Map(
                [...state.scopes.keys()].map((environmentId) => [
                  environmentId,
                  {
                    environment: {
                      capabilities: {
                        threadSettlement: true,
                        threadArchiveFamilies: true,
                        threadArchiveFamiliesV2: state.archiveSupport,
                        threadSnooze: true,
                        threadPinning: true,
                        threadPinReorder: true,
                        threadTitleRegeneration: true,
                      },
                    },
                  },
                ]),
              ),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "archive-family"
      ? async (request: { environmentId: string; input: { threadId: string } }) => {
          state.archiveFamilyReads.push(request);
          if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
            return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
          }
          return state.archiveFamilyError === undefined
            ? AsyncResult.success(
                state.archiveFamily ??
                  makeArchiveDecision([
                    state.shells.find(
                      (thread) =>
                        thread.id === request.input.threadId &&
                        thread.environmentId === request.environmentId,
                    ) ??
                      makeThread({
                        id: ThreadId.make(request.input.threadId),
                        environmentId: EnvironmentId.make(request.environmentId),
                      }),
                  ]),
              )
            : AsyncResult.failure(Cause.fail(state.archiveFamilyError));
        }
      : command,
}));
// Stubbed at the direct dependency: the real outbox pulls the Expo file-system
// storage into a test that only reads which threads are queued.
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued-thread-keys" }));
// The real hold lives in a module-level atom that would leak between cases.
vi.mock("../../state/thread-order", () => ({
  threadDropBusyAtom: "thread-drop-busy",
  getPendingThreadOrder: () => state.pendingOrder,
  beginPendingThreadOrder: () => {
    state.pendingOrder = {};
    return {
      isPending: () => state.pendingOrder !== null,
      complete: () => {
        state.pendingOrder = null;
      },
      cancel: () => {
        state.pendingOrder = null;
      },
    };
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "thread-shells" },
  threadEnvironment: {
    loadArchiveFamily: "archive-family",
    ...Object.fromEntries(
      [
        "archive",
        "unarchive",
        "delete",
        "settle",
        "unsettle",
        "snooze",
        "unsnooze",
        "pin",
        "unpin",
        "reorderPin",
        "updateMetadata",
      ].map((action) => [
        action,
        async (request: {
          environmentId: string;
          input: { threadId: string; orderKey?: string };
        }) => {
          state.requests.push({ action, ...request });
          if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
            return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
          }
          state.afterRequest?.();
          if (action === "archive" && state.archiveMutationError)
            return AsyncResult.failure(Cause.fail(state.archiveMutationError));
          return AsyncResult.success(undefined);
        },
      ]),
    ),
  },
}));

import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    ...input,
  });
}

function makeArchiveDecision(
  threads: EnvironmentThreadShell[],
  children: EnvironmentThreadShell[] = [],
  options: Partial<Parameters<typeof resolveThreadArchiveFamily>[0]> = {},
): Parameters<typeof resolveThreadArchiveFamily>[0] {
  return {
    threads,
    children,
    childThreadIds: children.map((child) => child.id),
    promotableChildThreadIds: [],
    keptThreadIds: [],
    activeChildThreadIds: [],
    activeThreadIds: [],
    unreadThreadIds: [],
    protectedChildThreadIds: [],
    nativeStopCount: 0,
    requiresConfirmation: false,
    canPromote: false,
    canStopAndArchive: true,
    activeChildren: [],
    activeThreads: [],
    unreadThreads: [],
    promotableChildren: [],
    protectedChildren: [],
    ...options,
  };
}

const mutationCases = [
  ["archiveThread", "archive"],
  ["settleThread", "settle"],
  ["unsettleThread", "unsettle"],
  ["snoozeThread", "snooze"],
  ["unsnoozeThread", "unsnooze"],
  ["pinThread", "pin"],
  ["unpinThread", "unpin"],
  ["regenerateThreadTitle", "updateMetadata"],
] as const;

beforeEach(() => {
  state.pendingOrder = null;
  state.dropBusy = false;
  state.scopes = new Map([
    [primaryEnvironmentId, new Set([AuthOrchestrationOperateScope])],
    [otherEnvironmentId, new Set<string>()],
  ]);
  state.requests = [];
  state.shells = [];
  state.archiveFamily = undefined;
  state.archiveFamilyError = undefined;
  state.archiveMutationError = undefined;
  state.archiveFamilyReads = [];
  state.archiveSupport = true;
  state.alertMessages = [];
  state.dialogs = [];
  state.alerts = [];
  state.afterRequest = undefined;
  state.afterAlert = undefined;
});

afterEach(() => vi.unstubAllEnvs());

describe("archive family reads", () => {
  const workingRuntime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "codex",
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it.each([
    ["Stop active threads & archive", "stop_and_archive"],
    ["Cancel", null],
  ])(
    "asks before stopping a working owner with idle children: %s",
    async (buttonText, disposition) => {
      const root = makeThread({ runtime: workingRuntime });
      const child = makeThread({
        id: ThreadId.make("idle-child"),
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: "subagent",
        },
      });
      state.shells = [root];
      state.archiveFamily = makeArchiveDecision([root, child], [child], {
        activeThreadIds: [root.id],
        activeThreads: [root],
        requiresConfirmation: true,
        canPromote: true,
      });
      const archiving = useThreadListActions().archiveThread(root);
      await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
      expect(state.archiveFamilyReads).toHaveLength(1);
      expect(state.requests).toEqual([]);
      expect(state.alertMessages[0]).toContain("Thread · Working");
      expect(state.alerts[0]?.buttons?.map(({ text }) => text)).toEqual([
        "Cancel",
        "Stop active threads & archive",
      ]);
      state.alerts[0]!.buttons!.find((button) => button.text === buttonText)!.onPress!();
      await archiving;
      expect(state.requests).toEqual(
        disposition === null
          ? []
          : [
              expect.objectContaining({
                action: "archive",
                input: {
                  threadId: root.id,
                  childDisposition: disposition,
                  expectedChildThreadIds: [child.id],
                },
              }),
            ],
      );
    },
  );

  it.each([
    ["Stop active threads & archive", "stop_and_archive"],
    ["Cancel", null],
  ])(
    "uses the authoritative working owner despite locally idle state: %s",
    async (buttonText, disposition) => {
      const local = makeThread({ title: "Stale title", runtime: null });
      const owner = { ...local, title: "Authoritative title", runtime: workingRuntime };
      const child = makeThread({
        id: ThreadId.make("idle-child"),
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: "subagent",
        },
      });
      state.shells = [local];
      state.archiveFamily = makeArchiveDecision([owner, child], [child], {
        activeThreadIds: [owner.id],
        activeThreads: [owner],
        requiresConfirmation: true,
        canPromote: true,
      });
      const archiving = useThreadListActions().archiveThread(local);
      await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
      expect(state.alerts[0]?.title).toContain("Authoritative title");
      expect(state.requests).toEqual([]);
      state.alerts[0]!.buttons!.find((button) => button.text === buttonText)!.onPress!();
      await archiving;
      expect(state.requests).toEqual(
        disposition === null
          ? []
          : [
              expect.objectContaining({
                action: "archive",
                input: {
                  threadId: owner.id,
                  childDisposition: disposition,
                  expectedChildThreadIds: [child.id],
                },
              }),
            ],
      );
    },
  );

  it("archives the authoritative idle standalone owner despite locally running state", async () => {
    const local = makeThread({ runtime: workingRuntime });
    state.shells = [local];
    state.archiveFamily = makeArchiveDecision([{ ...local, runtime: null }]);
    await useThreadListActions().archiveThread(local);
    expect(state.requests).toEqual([
      expect.objectContaining({
        action: "archive",
        input: {
          threadId: local.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [],
        },
      }),
    ]);
    expect(state.alerts).toEqual([]);
  });

  it("archives idle owned children without granting stop consent", async () => {
    const root = makeThread();
    const child = makeThread({
      id: ThreadId.make("idle-child"),
      lineage: { rootThreadId: root.id, parentThreadId: root.id, relationshipToParent: "subagent" },
    });
    state.shells = [root];
    state.archiveFamily = makeArchiveDecision([root, child], [child]);
    await useThreadListActions().archiveThread(root);
    expect(state.alerts).toEqual([]);
    expect(state.requests).toEqual([
      expect.objectContaining({
        action: "archive",
        input: {
          threadId: root.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      }),
    ]);
  });

  it.each(["dismissed", "replaced"] as const)(
    "preserves the displayed failure when fresh mobile shells are %s",
    async (change) => {
      const owner = makeThread({ id: ThreadId.make("owner") });
      const pending = {
        threadId: owner.id,
        commandId: CommandId.make("observed-failure"),
        status: "failed" as const,
      };
      const displayedChild = makeThread({
        id: ThreadId.make("failed-child"),
        archivePending: pending,
        lineage: {
          rootThreadId: owner.id,
          parentThreadId: owner.id,
          relationshipToParent: "subagent",
        },
      });
      const latestChild = {
        ...displayedChild,
        archivePending:
          change === "dismissed"
            ? null
            : { ...pending, commandId: CommandId.make("newer-failure") },
      };
      state.shells = [owner, latestChild];
      state.archiveFamily = makeArchiveDecision([owner, latestChild], [latestChild]);
      state.archiveMutationError = new Error("This failed archive changed.");
      const rejected = new Promise<void>((resolve) => {
        state.afterAlert = resolve;
      });
      useThreadListActions().archiveThread(displayedChild);
      await rejected;
      expect(state.archiveFamilyReads).toEqual([
        { environmentId: owner.environmentId, input: { threadId: owner.id } },
      ]);
      expect(state.requests).toEqual([
        expect.objectContaining({
          action: "archive",
          input: {
            threadId: owner.id,
            childDisposition: "archive_if_idle",
            expectedChildThreadIds: [latestChild.id],
            expectedArchiveCommandId: pending.commandId,
          },
        }),
      ]);
      expect(state.alertMessages).toEqual(["This failed archive changed."]);
    },
  );

  it("reports newly active family rejection without resubmitting stop consent", async () => {
    const root = makeThread();
    const child = makeThread({
      id: ThreadId.make("idle-child"),
      lineage: { rootThreadId: root.id, parentThreadId: root.id, relationshipToParent: "subagent" },
    });
    state.shells = [root];
    state.archiveFamily = makeArchiveDecision([root, child], [child]);
    state.archiveMutationError = new Error(
      "This family now has work that needs attention. Review the archive choices again.",
    );
    await useThreadListActions().archiveThread(root);
    expect(state.requests).toEqual([
      expect.objectContaining({
        action: "archive",
        input: {
          threadId: root.id,
          childDisposition: "archive_if_idle",
          expectedChildThreadIds: [child.id],
        },
      }),
    ]);
    await vi.waitFor(() =>
      expect(state.alertMessages[0]).toContain("Review the archive choices again"),
    );
    expect(state.archiveFamilyReads).toHaveLength(1);
  });

  it("refreshes membership and asks for new consent after a failed native archive", async () => {
    const root = makeThread();
    const first = makeThread({ id: ThreadId.make("first-child"), title: "First child" });
    const added = makeThread({ id: ThreadId.make("added-child"), title: "Added child" });
    state.archiveFamily = makeArchiveDecision([root, first], [first], {
      activeThreadIds: [first.id],
      activeThreads: [first],
      requiresConfirmation: true,
    });
    state.archiveMutationError = new Error("The family changed. Review the archive choices again.");
    const actions = useThreadListActions();
    actions.archiveThread(root);
    await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
    expect(
      state.alerts[0]!.buttons!.some((button) => button.text === "Keep running separately"),
    ).toBe(false);
    state.alerts[0]!.buttons!.find((button) => button.text === "Stop active threads & archive")!
      .onPress!();
    await vi.waitFor(() => expect(state.alerts[1]?.title).toBe("Could not archive thread"));
    expect(state.requests[0]?.input).toEqual({
      threadId: root.id,
      childDisposition: "stop_and_archive",
      expectedChildThreadIds: [first.id],
    });

    state.archiveMutationError = undefined;
    state.archiveFamily = makeArchiveDecision([root, first, added], [first, added], {
      activeThreadIds: [first.id, added.id],
      activeThreads: [first, added],
      requiresConfirmation: true,
      canPromote: true,
    });
    actions.archiveThread(root);
    await vi.waitFor(() => expect(state.alerts[2]?.buttons).toBeDefined());
    expect(state.archiveFamilyReads).toHaveLength(2);
    expect(state.requests).toHaveLength(1);
    expect(state.alertMessages[2]).toContain("Added child · Working");
    expect(state.alerts[2]?.buttons?.map(({ text }) => text)).toEqual([
      "Cancel",
      "Stop active threads & archive",
    ]);
    state.alerts[2]!.buttons!.find((button) => button.text === "Stop active threads & archive")!
      .onPress!();
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
    expect(state.requests[1]?.input).toEqual({
      threadId: root.id,
      childDisposition: "stop_and_archive",
      expectedChildThreadIds: [first.id, added.id],
    });
  });

  it("reviews an unread owner without consenting to stop newly active work", async () => {
    const root = makeThread();
    const child = makeThread({
      id: ThreadId.make("idle-child"),
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "subagent",
      },
    });
    state.shells = [root];
    state.archiveFamily = makeArchiveDecision([root, child], [child], {
      unreadThreadIds: [root.id],
      unreadThreads: [root],
      requiresConfirmation: true,
      canPromote: true,
    });
    const archiving = useThreadListActions().archiveThread(root);
    await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
    expect(state.requests).toEqual([]);
    expect(state.alertMessages[0]).toContain("Thread · Unread");
    expect(state.alerts[0]?.buttons?.map(({ text }) => text)).toEqual([
      "Cancel",
      "Archive unread threads",
    ]);
    state.alerts[0]!.buttons!.find((button) => button.text === "Archive unread threads")!
      .onPress!();
    await archiving;
    expect(state.requests).toEqual([
      expect.objectContaining({
        action: "archive",
        input: {
          threadId: root.id,
          childDisposition: "archive_after_review",
          expectedChildThreadIds: [child.id],
        },
      }),
    ]);
  });

  it("offers only Close for protected family members despite promotion availability", async () => {
    const root = makeThread();
    const protectedChild = makeThread({ id: ThreadId.make("persistent-child"), persistent: true });
    state.archiveFamily = makeArchiveDecision([root, protectedChild], [protectedChild], {
      protectedChildThreadIds: [protectedChild.id],
      protectedChildren: [protectedChild],
      requiresConfirmation: true,
      canStopAndArchive: false,
      canPromote: true,
    });
    useThreadListActions().archiveThread(root);
    await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
    expect(state.requests).toEqual([]);
    expect(state.alerts[0]?.buttons?.map(({ text }) => text)).toEqual(["Close"]);
    expect(state.alertMessages[0]).toMatch(/persistent|protected/i);
    state.alerts[0]!.buttons![0]!.onPress!();
    expect(state.requests).toEqual([]);
  });

  it.each(["missing", "persistent"] as const)(
    "blocks archive when the authoritative owner is %s",
    async (kind) => {
      const local = makeThread();
      state.shells = [local];
      state.archiveFamily = makeArchiveDecision(
        kind === "missing" ? [] : [{ ...local, persistent: true }],
      );
      await useThreadListActions().archiveThread(local);
      expect(state.requests).toEqual([]);
      expect(state.alertMessages[0]).toContain(
        kind === "missing" ? "owner is no longer available" : "persistent protection",
      );
    },
  );

  it.each(["none", "fork", "independent"] as const)(
    "confirms working standalone archive after the family read: %s",
    async (kind) => {
      const root = makeThread({ runtime: workingRuntime });
      const unrelated = makeThread({
        id: ThreadId.make("unowned-child"),
        lineage: {
          rootThreadId: root.id,
          parentThreadId: root.id,
          relationshipToParent: kind === "fork" ? "fork" : "subagent",
          ...(kind === "independent" ? { independent: true } : {}),
        },
      });
      state.shells = [root];
      state.archiveFamily = makeArchiveDecision(kind === "none" ? [root] : [root, unrelated], [], {
        activeThreadIds: [root.id],
        activeThreads: [root],
        requiresConfirmation: true,
      });
      const archiving = useThreadListActions().archiveThread(root);
      await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
      expect(state.archiveFamilyReads).toHaveLength(1);
      expect(state.requests).toEqual([]);
      expect(state.alertMessages[0]).toContain("Thread · Working");
      expect(state.alerts[0]?.buttons?.map(({ text }) => text)).toEqual([
        "Cancel",
        "Stop active threads & archive",
      ]);
      state.alerts[0]!.buttons![1]!.onPress!();
      await archiving;
      expect(state.requests).toEqual([
        expect.objectContaining({
          action: "archive",
          input: {
            threadId: root.id,
            childDisposition: "stop_and_archive",
            expectedChildThreadIds: [],
          },
        }),
      ]);
    },
  );

  it.each([undefined, false])(
    "requires a server update before querying legacy-only archive families (V2=%s)",
    async (support) => {
      state.archiveSupport = support;
      await useThreadListActions().archiveThread(makeThread());
      expect(state.archiveFamilyReads).toEqual([]);
      expect(state.requests).toEqual([]);
      expect(state.alerts[0]?.title).toBe("Server update required");
      expect(state.alertMessages[0]).toContain("Update this environment's server");
    },
  );
  it("confirms a live descendant reached through an inactive owner", async () => {
    const root = makeThread();
    const intermediate = makeThread({
      id: ThreadId.make("inactive-owner"),
      archivedAt: "2026-09-02T00:00:00.000Z",
      lineage: { parentThreadId: root.id, rootThreadId: root.id, relationshipToParent: "subagent" },
    });
    const descendant = makeThread({
      id: ThreadId.make("live-descendant"),
      hasPendingApprovals: true,
      lineage: {
        parentThreadId: intermediate.id,
        rootThreadId: root.id,
        relationshipToParent: "subagent",
      },
    });
    state.shells = [root, descendant];
    state.archiveFamily = makeArchiveDecision([root, intermediate, descendant], [descendant], {
      activeThreadIds: [descendant.id],
      activeThreads: [descendant],
      requiresConfirmation: true,
      activeChildren: [descendant],
      activeChildThreadIds: [descendant.id],
    });
    const archiving = useThreadListActions().archiveThread(root);
    await vi.waitFor(() => expect(state.alerts[0]?.buttons).toBeDefined());
    expect(state.requests).toEqual([]);
    state.alerts[0]!.buttons!.find((button) => button.text === "Stop active threads & archive")!
      .onPress!();
    await archiving;
    expect(state.archiveFamilyReads).toEqual([
      { environmentId: root.environmentId, input: { threadId: root.id } },
    ]);
    expect(state.requests).toEqual([
      expect.objectContaining({
        action: "archive",
        environmentId: root.environmentId,
        input: {
          threadId: root.id,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [descendant.id],
        },
      }),
    ]);
  });

  it("reports a failed family read and dispatches nothing", async () => {
    state.archiveFamilyError = new Error("Family unavailable");
    await useThreadListActions().archiveThread(makeThread());
    expect(state.requests).toEqual([]);
    expect(state.alerts).toEqual([{ title: "Could not archive thread", buttons: undefined }]);
  });
});

describe("thread list operation permissions", () => {
  it.each(mutationCases)(
    "%s rejects a retained callback after its environment loses permission",
    async (handler) => {
      const actions = useThreadListActions();
      state.scopes.get(primaryEnvironmentId)!.clear();

      await actions[handler](makeThread(), "2099-01-01T00:00:00.000Z");

      expect(state.requests).toEqual([]);
    },
  );

  it.each(mutationCases)("%s requires the target environment's permission", async (handler) => {
    await useThreadListActions()[handler](
      makeThread({ environmentId: otherEnvironmentId }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(state.requests).toEqual([]);
  });

  it.each(mutationCases)(
    "%s works when the target environment gains only task permission",
    async (handler, action) => {
      state.scopes.get(primaryEnvironmentId)!.clear();
      const actions = useThreadListActions();
      state.scopes.get(otherEnvironmentId)!.add(AuthOrchestrationOperateScope);

      await actions[handler](
        makeThread({ environmentId: otherEnvironmentId }),
        "2099-01-01T00:00:00.000Z",
      );

      expect(state.requests).toEqual([
        expect.objectContaining({ action, environmentId: otherEnvironmentId }),
      ]);
    },
  );

  it.each(["ios", "android"])("does not show a forbidden %s delete confirmation", (os) => {
    vi.stubEnv("EXPO_OS", os);
    useThreadListActions().confirmDeleteThread(makeThread({ environmentId: otherEnvironmentId }));

    expect(state.dialogs).toEqual([]);
    expect(state.alerts.some((alert) => alert.title === "Delete thread?")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it.each(["ios", "android"])(
    "rechecks permission after a retained %s delete confirmation",
    async (os) => {
      vi.stubEnv("EXPO_OS", os);
      useThreadListActions().confirmDeleteThread(makeThread());
      const confirm =
        os === "ios"
          ? state.alerts[0]?.buttons?.find((button) => button.text === "Delete")?.onPress
          : state.dialogs[0]?.onConfirm;
      expect(confirm).toBeTypeOf("function");
      state.scopes.get(primaryEnvironmentId)!.clear();

      await confirm!();

      expect(state.requests).toEqual([]);
    },
  );

  it("unarchives with only task permission and blocks a later revoked callback", async () => {
    const actions = useArchivedThreadListActions(() => {}, []);
    const thread = makeThread({ archivedAt: "2026-09-02T00:00:00.000Z" });
    await actions.unarchiveThread(thread);
    expect(state.requests).toEqual([expect.objectContaining({ action: "unarchive" })]);
    state.requests = [];
    state.scopes.get(primaryEnvironmentId)!.clear();

    await actions.unarchiveThread(thread);

    expect(state.requests).toEqual([]);
  });

  it("keeps delete independent of terminal and source-control permissions", async () => {
    vi.stubEnv("EXPO_OS", "android");
    useArchivedThreadListActions(() => {}, []).confirmDeleteThread(makeThread());
    await state.dialogs[0]!.onConfirm();

    expect(state.requests).toEqual([expect.objectContaining({ action: "delete" })]);
  });
});

describe("pinned thread operation permissions", () => {
  it("checks every materialization target before writing any keys", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it("moves a keyed thread past a read-only neighbor without writing that neighbor", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "m" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "g",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "reorderPin", environmentId: primaryEnvironmentId }),
    ]);
  });

  it("rechecks permission between materialization writes", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    state.afterRequest = () => state.scopes.get(primaryEnvironmentId)!.clear();

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});
