import {
  CommandId,
  EnvironmentId,
  OrchestrationV2ThreadShellJson,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  archiveChildNeedsAttention,
  archiveRetryThreadId,
  presentThreadArchive,
} from "./threadArchive.ts";
import { presentThreadShell } from "./models.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const base = presentThreadShell(EnvironmentId.make("environment-test"), v2ThreadShell);
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShellJson);
const idleRuntime = {
  status: "idle" as const,
  activeRunId: null,
  providerInstanceId: base.providerInstanceId,
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-07T00:00:00.000Z",
};
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

describe("archive family attention", () => {
  it("does not require a choice for dormant or successfully recovered children", () => {
    expect(archiveChildNeedsAttention(base)).toBe(false);
    expect(
      archiveChildNeedsAttention({
        ...base,
        recovery: {
          runId: RunId.make("old-run"),
          attemptId: RunAttemptId.make("old-attempt"),
          status: "recovered",
          detail: "Recovered",
          updatedAt: v2Now,
        },
      }),
    ).toBe(false);
  });
  it.each(["suspect", "stale", "recovering", "failed"] as const)(
    "requires a choice for %s recovery with idle provider runtime",
    (status) => {
      expect(
        archiveChildNeedsAttention({
          ...base,
          runtime: idleRuntime,
          recovery: {
            runId: RunId.make("old-run"),
            attemptId: RunAttemptId.make("old-attempt"),
            status,
            detail: "Provider stopped responding",
            updatedAt: v2Now,
          },
        }),
      ).toBe(true);
    },
  );
  it("requires a choice for waiting and working Actions even with no active provider run", () => {
    expect(
      archiveChildNeedsAttention({ ...base, runtime: idleRuntime, actionResume: action }),
    ).toBe(true);
    expect(
      archiveChildNeedsAttention({
        ...base,
        runtime: idleRuntime,
        actionResume: {
          ...action,
          progress: {
            version: 1,
            state: "working",
            summary: "Running checks",
            updatedAt: action.startedAt,
          },
        },
      }),
    ).toBe(true);
    expect(
      archiveChildNeedsAttention({
        ...base,
        actionResume: { ...action, outcome: "succeeded", finishedAt: action.startedAt },
      }),
    ).toBe(false);
  });
});

describe("durable archive presentation", () => {
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
