import {
  EnvironmentId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShellJson,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadRecovery,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  presentThreadRecovery,
  recoverySuppressesWorking,
  threadRecoveryStatusLabel,
} from "./threadRecovery.ts";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell, v2Projection } from "./orchestrationV2TestFixtures.ts";

function recovery(status: OrchestrationV2ThreadRecovery["status"]): OrchestrationV2ThreadRecovery {
  return {
    runId: RunId.make("run-1"),
    attemptId: RunAttemptId.make("attempt-1"),
    status,
    detail: "The provider reports this turn has ended.",
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  };
}

describe("thread recovery presentation", () => {
  it("preserves incident timestamps through persistence and shell transport", () => {
    const incident = recovery("failed");
    const shell = { ...v2ThreadShell, recovery: incident };
    const shellJson = Schema.encodeSync(OrchestrationV2ThreadShellJson)(shell);
    expect(shellJson.recovery?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson)(shellJson).recovery).toEqual(
      incident,
    );
    const thread = { ...v2Projection.thread, recovery: incident };
    const threadJson = Schema.encodeSync(OrchestrationV2AppThreadJson)(thread);
    expect(Schema.decodeUnknownSync(OrchestrationV2AppThreadJson)(threadJson).recovery).toEqual(
      incident,
    );
  });
  it("ignores an older incident when a new run owns activity", () => {
    const thread = presentThreadShell(EnvironmentId.make("env-1"), {
      ...v2ThreadShell,
      recovery: recovery("failed"),
      activeRunId: RunId.make("new-run"),
    });
    expect(thread.recovery).toBeNull();
  });

  it("keeps the active incident when a later queued run was cancelled", () => {
    const incident = recovery("failed");
    const thread = presentThreadShell(EnvironmentId.make("env-1"), {
      ...v2ThreadShell,
      recovery: incident,
      activeRunId: incident.runId,
      latestRunId: RunId.make("cancelled-later-run"),
    });
    expect(thread.recovery).toBe(incident);
  });
  it("does not replace working or claim failure for unconfirmed suspicion", () => {
    expect(recoverySuppressesWorking(recovery("suspect"))).toBe(false);
    expect(threadRecoveryStatusLabel(recovery("suspect"))).toBeNull();
    expect(presentThreadRecovery(recovery("suspect"), false)?.action).toBe("recover");
    expect(presentThreadRecovery(undefined, false)).toBeNull();
  });

  it("prevents another action while deterministic recovery runs", () => {
    const state = presentThreadRecovery(recovery("recovering"), false);
    expect(state?.busy).toBe(true);
    expect(state?.action).toBeNull();
    expect(state?.suppressWorking).toBe(true);
    expect(state?.description).toBe(recovery("recovering").detail);
  });

  it("offers agent repair only after deterministic techniques fail, then opens the existing thread", () => {
    expect(presentThreadRecovery(recovery("stale"), false)?.action).toBe("recover");
    expect(presentThreadRecovery(recovery("failed"), false)?.action).toBe("launch-repair");
    expect(
      presentThreadRecovery(
        {
          ...recovery("failed"),
          repairThreadId: ThreadId.make("repair-1"),
        },
        true,
      )?.action,
    ).toBe("view-repair");
    expect(threadRecoveryStatusLabel(recovery("failed"))).toBe("Needs repair");
  });

  it("offers to open a repair conversation when its linked shell is missing or deleted", () => {
    const incident = {
      ...recovery("failed"),
      repairThreadId: ThreadId.make("deleted-repair"),
    };
    const unavailable = presentThreadRecovery(incident, false);
    expect(unavailable?.action).toBe("launch-repair");
    expect(unavailable?.label).toBe("Open repair thread");
    expect(unavailable?.description).toContain("continue investigating this run");
    const available = presentThreadRecovery(incident, true);
    expect(available?.action).toBe("view-repair");
    expect(available?.label).toBe("View repair thread");
  });

  it("keeps a recovery receipt without an action or a broken-working indicator", () => {
    expect(presentThreadRecovery(recovery("recovered"), false)?.action).toBeNull();
    expect(recoverySuppressesWorking(recovery("recovered"))).toBe(false);
    expect(threadRecoveryStatusLabel(recovery("recovered"))).toBeNull();
  });
});
