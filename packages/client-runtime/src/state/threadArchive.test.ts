import {
  CommandId,
  EnvironmentId,
  OrchestrationV2ThreadShellJson,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
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
