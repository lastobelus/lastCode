import {
  CommandId,
  EnvironmentId,
  OrchestrationV2ThreadShellJson,
  ProjectId,
  NodeId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  consultThreadArchiveAgent,
  THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE,
  THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE,
  archivePreviewSelection,
  archiveRetryThreadId,
  getArchiveRecoveryRows,
  presentThreadArchive,
  buildThreadArchiveConfirmation,
} from "./threadArchive.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const base = presentThreadShell(EnvironmentId.make("environment-test"), v2ThreadShell);

describe("archive confirmation", () => {
  const child = { ...base, id: ThreadId.make("child"), title: "Review implementation" };
  const family = {
    threads: [base, child],
    children: [child],
    activeThreadIds: [],
    unreadThreadIds: [child.id],
    protectedChildThreadIds: [],
    canStopAndArchive: true,
  };
  it("warns about unread replies without consenting to stop newly active work", () => {
    const confirmation = buildThreadArchiveConfirmation(family);
    expect(confirmation.confirmLabel).toBe("Archive unread threads");
    expect(confirmation.disposition).toBe("archive_after_review");
    expect(confirmation.threads).toEqual([{ thread: child, label: "Unread" }]);
    expect(confirmation.description).toContain("Replies stay in archived history");
  });
  it("lists an active owner and dual-status child once", () => {
    const confirmation = buildThreadArchiveConfirmation({
      ...family,
      activeThreadIds: [base.id, child.id],
    });
    expect(confirmation.disposition).toBe("stop_and_archive");
    expect(confirmation.threads.map(({ label }) => label)).toEqual(["Working", "Working · Unread"]);
    expect(confirmation.description).toContain("cancels pending approvals and queued messages");
  });
  it("blocks the whole operation for a protected child", () => {
    const confirmation = buildThreadArchiveConfirmation({
      ...family,
      threads: [base, { ...child, persistent: true }],
      protectedChildThreadIds: [child.id],
      canStopAndArchive: false,
    });
    expect(confirmation.blocked).toBe(true);
    expect(confirmation.threads[0]?.label).toBe("Persistent");
    expect(confirmation.description).toContain("can't be archived");
  });
  it("keeps bulk project names in sync with consent and scopes duplicates by environment", () => {
    const scratch = {
      projectId: ProjectId.make("scratch"),
      title: "Scratch",
      requiresTypedIn: false,
    };
    const typedIn = {
      projectId: ProjectId.make("typed-in"),
      title: "Typed in",
      requiresTypedIn: true,
    };
    const archivePreview = {
      environmentId: base.environmentId,
      threads: [],
      typedInThreadIds: [child.id],
      temporaryProjects: [scratch, typedIn],
    };
    const remote = {
      ...archivePreview,
      environmentId: EnvironmentId.make("remote"),
      temporaryProjects: [{ ...scratch, title: "Remote scratch" }],
    };
    const bulk = {
      ...family,
      activeThreadIds: [base.id],
      bulkPreviews: [archivePreview, archivePreview, remote].map((archivePreview) => ({
        archivePreview,
        threads: family.threads,
      })),
    };
    const selection = { archivePreview, keptThreadIds: [child.id] };
    expect(archivePreviewSelection(selection).expectedTemporaryProjectIds).toEqual([
      scratch.projectId,
    ]);
    expect(archivePreviewSelection(selection, true).expectedTemporaryProjectIds).toEqual([
      scratch.projectId,
      typedIn.projectId,
    ]);
    const defaultConfirmation = buildThreadArchiveConfirmation(bulk);
    expect(defaultConfirmation.description).not.toContain(
      "Unread replies stay in archived history",
    );
    expect(defaultConfirmation.description).not.toContain("Unarchiving reopens history");
    expect(defaultConfirmation.temporaryProjects.map(({ title }) => title)).toEqual([
      "Scratch",
      "Remote scratch",
    ]);
    expect(
      buildThreadArchiveConfirmation(bulk, undefined, true).temporaryProjects.map(
        ({ title }) => title,
      ),
    ).toEqual(["Scratch", "Typed in", "Remote scratch"]);
  });
});
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShellJson);
const pending = {
  threadId: base.id,
  commandId: CommandId.make("archive-family"),
  childDisposition: "stop_and_archive" as const,
  childThreadIds: [],
  archiveThreadIds: [base.id],
  promoteThreadIds: [],
  status: "stopping" as const,
};
const action = {
  runId: "action-test",
  threadId: base.id,
  projectId: ProjectId.make("project-test"),
  actionId: "wait-for-pr",
  actionName: "Wait for PR",
  terminalId: "action-terminal",
  outcome: "running" as const,
  delivery: "pending" as const,
  startedAt: "2026-10-07T00:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
};

describe("durable archive presentation", () => {
  it.each(["stopping", "failed"] as const)(
    "surfaces the %s nested operation owner while retaining its descendants underneath it",
    (status) => {
      const ownerId = ThreadId.make("nested-owner");
      const owner = {
        ...base,
        id: ownerId,
        lineage: {
          rootThreadId: base.id,
          parentThreadId: base.id,
          relationshipToParent: "subagent" as const,
        },
        archivePending: { ...pending, threadId: ownerId, status },
      };
      const child = {
        ...owner,
        id: ThreadId.make("nested-child"),
        lineage: { ...owner.lineage, parentThreadId: ownerId },
      };
      expect([...getArchiveRecoveryRows([base, owner, child])]).toEqual([owner]);
      expect(owner.lineage).not.toHaveProperty("independent");
      expect(child.lineage).not.toHaveProperty("independent");
    },
  );
  it.each(["stopping", "failed"] as const)(
    "surfaces %s owned participants only when their archive owner is unavailable",
    (status) => {
      const child = {
        ...base,
        id: ThreadId.make("stranded-native"),
        lineage: {
          rootThreadId: base.id,
          parentThreadId: base.id,
          relationshipToParent: "subagent" as const,
        },
        archivePending: { ...pending, status },
      };
      expect([...getArchiveRecoveryRows([base, child])]).toEqual([]);
      expect([...getArchiveRecoveryRows([child])]).toEqual([child]);
      expect([
        ...getArchiveRecoveryRows([{ ...base, archivedAt: action.startedAt }, child]),
      ]).toEqual([child]);
      expect([
        ...getArchiveRecoveryRows([{ ...base, deletedAt: action.startedAt }, child]),
      ]).toEqual([child]);
      expect([...getArchiveRecoveryRows([{ ...child, archivePending: null }])]).toEqual([]);
      expect([...getArchiveRecoveryRows([{ ...child, deletedAt: action.startedAt }])]).toEqual([]);
      expect([...getArchiveRecoveryRows([{ ...child, archivedAt: action.startedAt }])]).toEqual([]);
      expect(child.lineage).not.toHaveProperty("independent");
    },
  );
  it("does not let an active same-id owner in another environment hide a stranded repair", () => {
    const child = {
      ...base,
      id: ThreadId.make("stranded-native"),
      lineage: {
        rootThreadId: base.id,
        parentThreadId: base.id,
        relationshipToParent: "subagent" as const,
      },
      archivePending: { ...pending, status: "failed" as const },
    };
    const foreignOwner = { ...base, environmentId: EnvironmentId.make("other-environment") };
    expect([...getArchiveRecoveryRows([foreignOwner, child])]).toEqual([child]);
  });
  it("retries a failed participant through the original operation owner without treating stopping as a retry", () => {
    const childId = ThreadId.make("native-child");
    const child = {
      ...base,
      id: childId,
      archivedAt: null,
      archivePending: { ...pending, status: "failed" as const },
    };
    expect(archiveRetryThreadId(child)).toBe(base.id);
    expect(
      archiveRetryThreadId({ ...child, archivePending: { ...pending, status: "stopping" } }),
    ).toBe(childId);
    expect(archiveRetryThreadId({ ...child, archivePending: null })).toBe(childId);
  });
  it.each(["stopping", "failed"] as const)(
    "restores %s presentation from a decoded shell without initiating client state",
    (status) => {
      const shell = decodeShell(
        encodeShell({
          ...v2ThreadShell,
          archivePending: {
            ...pending,
            status,
            error: status === "failed" ? "Provider shutdown timed out." : undefined,
          },
        }),
      );
      const displayed = presentThreadArchive(
        presentThreadShell(EnvironmentId.make("environment-test"), shell),
      );
      expect(displayed?.label).toBe(status === "failed" ? "Archive failed" : "Archiving…");
      if (status === "failed") {
        expect(displayed?.description).toContain("Provider shutdown timed out.");
        expect(displayed?.description).toContain("some work may have stopped");
        expect(displayed?.description).toContain("Archive again to retry");
      }
    },
  );
  it("clears the archive indication after the server clears the pending operation", () => {
    expect(presentThreadArchive({ archivePending: null })).toBeNull();
  });
});

describe("archive consultation", () => {
  const owner = { ...base, id: ThreadId.make("interactive-owner") };
  const work = { ...base, id: ThreadId.make("native-work"), title: "Implementation" };
  const familyRef = { environmentId: base.environmentId, threadId: base.id };
  const target = {
    ownerThreadId: owner.id,
    ownerTitle: "Coordinator",
    work: [
      {
        threadId: work.id,
        taskId: NodeId.make("task"),
        runId: RunId.make("run"),
        attemptId: RunAttemptId.make("attempt"),
      },
    ],
  };

  it("refreshes execution ownership and queues one question with scoped identities and the owner's modes", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const inspect = vi
      .fn()
      .mockResolvedValue({ threads: [base, work], consultationTargets: [target] });
    const readOwner = vi.fn().mockReturnValue(owner);
    let id = 0;
    const input = {
      familyRef,
      ownerThreadId: owner.id,
      inspect,
      readOwner,
      randomId: () => `new-id-${++id}`,
      send,
    };
    expect(await consultThreadArchiveAgent(input)).toBeNull();
    expect(await consultThreadArchiveAgent(input)).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(readOwner).toHaveBeenCalledWith({
      environmentId: base.environmentId,
      threadId: owner.id,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map(([value]) => value);
    expect(first).toMatchObject({
      environmentId: base.environmentId,
      input: {
        threadId: owner.id,
        dispatchMode: "queue",
        runtimeMode: owner.runtimeMode,
        interactionMode: owner.interactionMode,
      },
    });
    expect(first.input.commandId).not.toBe(second.input.commandId);
    expect(first.input.message.messageId).not.toBe(second.input.message.messageId);
    expect(first.input).not.toHaveProperty("modelSelection");
    for (const identity of [
      base.environmentId,
      base.id,
      owner.id,
      work.id,
      "task",
      "run",
      "attempt",
      "Implementation",
    ])
      expect(first.input.message.text).toContain(identity);
    expect(first.input.message.text).toContain("Do not archive this family");
    expect(first.input.message).toMatchObject({ role: "user", attachments: [] });
  });

  it.each(["busy", "unavailable", "missing", "self", "missing-owner", "archived-owner"] as const)(
    "keeps %s work available for review without dispatching a question",
    async (state) => {
      const send = vi.fn();
      const consultation =
        state === "self"
          ? { ...target, work: [{ threadId: owner.id }] }
          : state === "busy" || state === "unavailable"
            ? { ...target, unavailableReason: state }
            : target;
      const result = await consultThreadArchiveAgent({
        familyRef,
        ownerThreadId: owner.id,
        inspect: async () => ({
          threads: [base, work],
          ...(state === "missing" ? {} : { consultationTargets: [consultation] }),
        }),
        readOwner: () =>
          state === "missing-owner"
            ? null
            : state === "archived-owner"
              ? { ...owner, archivedAt: base.createdAt }
              : owner,
        randomId: () => {
          throw new Error("Must not allocate a paid action");
        },
        send,
      });
      expect(result).toBe(
        state === "busy"
          ? THREAD_ARCHIVE_CONSULTATION_BUSY_MESSAGE
          : THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE,
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("does not consult a stale owner after inspection maps the work to a different agent", async () => {
    const send = vi.fn();
    expect(
      await consultThreadArchiveAgent({
        familyRef,
        ownerThreadId: owner.id,
        inspect: async () => ({
          threads: [base, work],
          consultationTargets: [{ ...target, ownerThreadId: base.id }],
        }),
        readOwner: () => owner,
        randomId: () => "unused",
        send,
      }),
    ).toBe(THREAD_ARCHIVE_CONSULTATION_UNAVAILABLE_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });
});
