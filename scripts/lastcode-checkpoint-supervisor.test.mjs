import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  boundedCommandDiagnostic,
  checkpointEnvironment,
  checkpointFailureMessage,
  checkpointIncidentFingerprint,
  latestFailedCheckpointRun,
  refreshInstalledSupervisor,
  runCheckpointSupervisor,
} from "./lastcode-checkpoint-supervisor.mjs";

function fixture(overrides = {}) {
  const states = [];
  const messages = [];
  let state = overrides.state ?? null;
  let now = 0;
  const dependencies = {
    latestFailedCheckpointRun: () => ({
      status: "failed",
      upstreamTag: "v0.0.35-nightly.20260826.1195",
      failurePhase: "rebase",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.20260826.1195",
      error: "rebase failed",
    }),
    loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-maintenance" }),
    loadState: () => state,
    now: () => `2026-08-26T00:00:0${now++}.000Z`,
    notify: vi.fn(),
    refreshSupervisor: vi.fn(),
    runPhase: vi.fn(),
    sendThread: (threadId, message) => messages.push({ message, threadId }),
    writeState: (next) => {
      state = next;
      states.push(next);
    },
    ...overrides.dependencies,
  };
  return {
    dependencies,
    get state() {
      return state;
    },
    messages,
    states,
  };
}

describe("LastCode checkpoint supervisor", () => {
  it("runs the complete checkpoint pipeline and records terminal success", () => {
    const test = fixture();

    expect(runCheckpointSupervisor({}, test.dependencies)).toMatchObject({
      status: "success",
      phase: "complete",
    });
    expect(test.dependencies.runPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "fetch",
      "checkout",
      "dependencies",
      "checkpoint",
    ]);
    expect(test.dependencies.refreshSupervisor).toHaveBeenCalledOnce();
    expect(test.messages).toEqual([]);
    expect(test.states.at(-1)).toMatchObject({ status: "success", phase: "complete" });
  });

  it("persists a new checkpoint blocker before alerting one maintenance thread", () => {
    const test = fixture({
      dependencies: {
        runPhase: vi.fn((phase) => {
          if (phase === "checkpoint") throw new Error("checkpoint failed");
        }),
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("checkpoint failed");
    expect(test.states[0]).toMatchObject({
      status: "failed",
      phase: "checkpoint",
      incident: { alertDelivery: "pending", deliveryAttempts: 0 },
    });
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent", deliveryAttempts: 1 },
    });
    expect(test.messages).toHaveLength(1);
    expect(test.messages[0]).toMatchObject({ threadId: "thread-maintenance" });
    expect(test.messages[0]?.message).toContain("Use this thread for the recovery");
  });

  it("does not redeliver the same blocker after acknowledgement", () => {
    const failedRun = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({ dependencies: { runPhase: failedRun } });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");

    const second = fixture({
      state: first.state,
      dependencies: { runPhase: failedRun },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("fetch failed");
    expect(second.messages).toEqual([]);
    expect(second.state.incident.deliveryAttempts).toBe(1);
  });

  it("keeps failed delivery pending and retries it on the next run", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({
      dependencies: {
        runPhase,
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");
    expect(first.state.incident.alertDelivery).toBe("pending");

    const second = fixture({ state: first.state, dependencies: { runPhase } });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("fetch failed");
    expect(second.messages).toHaveLength(1);
    expect(second.state.incident.alertDelivery).toBe("sent");
    expect(second.state.incident.deliveryAttempts).toBe(2);
  });

  it("sends one closure after a failed incident recovers", () => {
    const previous = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");

    const recovered = fixture({ state: previous.state });
    expect(runCheckpointSupervisor({}, recovered.dependencies)).toMatchObject({
      status: "success",
      incident: { resolutionDelivery: "sent" },
    });
    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");

    const stillHealthy = fixture({ state: recovered.state });
    runCheckpointSupervisor({}, stillHealthy.dependencies);
    expect(stillHealthy.messages).toEqual([]);
  });

  it("does not inherit unrelated or credential-bearing session variables", () => {
    expect(
      checkpointEnvironment(
        {
          HOME: "/wrong",
          PATH: "/wrong",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          ELECTRON_RUN_AS_NODE: "1",
          SECRET_TOKEN: "do-not-copy",
          USER: "lasto",
        },
        "/Users/lasto",
        "/opt/pinned-node/bin/node",
      ),
    ).toEqual({
      HOME: "/Users/lasto",
      PATH: "/opt/pinned-node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USER: "lasto",
    });
  });

  it("keeps recovery instructions bounded and tied to the retained branch", () => {
    const message = checkpointFailureMessage(
      {
        phase: "checkpoint",
        error: "rebase failed",
        checkpointRun: {
          upstreamTag: "nightly-1",
          recoveryBranch: "sync/nightly/nightly-1",
        },
      },
      "abcdef1234567890",
    );
    expect(message).toContain("abcdef123456");
    expect(message).toContain("sync/nightly/nightly-1");
    expect(message).toContain("lastcode-checkpoints --verbose");
    expect(message).toContain("nightly-checkpoint.stderr.log");
  });

  it("distinguishes different recorded checkpoint blockers behind the same wrapper error", () => {
    const baseFailure = {
      phase: "checkpoint",
      error: "node failed with exit code 1",
      checkpointRun: {
        upstreamTag: "nightly-1",
        failurePhase: "smoke",
        recoveryBranch: "sync/nightly/nightly-1",
      },
    };

    expect(
      checkpointIncidentFingerprint({
        ...baseFailure,
        checkpointRun: { ...baseFailure.checkpointRun, error: "migration smoke failed" },
      }),
    ).not.toBe(
      checkpointIncidentFingerprint({
        ...baseFailure,
        checkpointRun: { ...baseFailure.checkpointRun, error: "server typecheck failed" },
      }),
    );
  });

  it("distinguishes pre-checkpoint blockers with the same command exit", () => {
    const baseFailure = {
      phase: "fetch",
      error: "git failed with exit code 128",
      checkpointRun: null,
    };

    expect(
      checkpointIncidentFingerprint({ ...baseFailure, diagnostic: "host key verification failed" }),
    ).not.toBe(
      checkpointIncidentFingerprint({ ...baseFailure, diagnostic: "repository not found" }),
    );
  });

  it("bounds and redacts command diagnostics before persistence or delivery", () => {
    const diagnostic = boundedCommandDiagnostic(
      `https://user:password@example.com/repo token=secret-value github_pat_abcdefghijklmnopqrstuvwxyz ${"x".repeat(2_000)}`,
    );

    expect(diagnostic.length).toBeLessThanOrEqual(1_203);
    expect(diagnostic).not.toContain("user:password");
    expect(diagnostic).not.toContain("secret-value");
    expect(diagnostic).not.toContain("github_pat_");
    expect(diagnostic.endsWith("x".repeat(1_000))).toBe(true);
  });

  it("ignores invalid history shapes while finding the latest valid failure", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    NodeFS.writeFileSync(
      historyPath,
      `${JSON.stringify({ status: "failed", error: "original failure" })}\nnull\n`,
    );

    expect(latestFailedCheckpointRun(historyPath)).toMatchObject({
      status: "failed",
      error: "original failure",
    });
    NodeFS.rmSync(directory, { recursive: true });
  });

  it("preserves and reports the original failure when history enrichment fails", () => {
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => {
          throw new Error("history unreadable");
        },
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("original checkpoint failure");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "original checkpoint failure",
    );
    expect(test.state).toMatchObject({
      status: "failed",
      incident: {
        alertDelivery: "sent",
        failure: { error: "original checkpoint failure", checkpointRun: null },
      },
    });
    expect(test.messages).toHaveLength(1);
  });

  it("turns corrupt durable state into a reportable supervisor incident", () => {
    const test = fixture({
      dependencies: {
        loadState: () => {
          throw new Error("invalid state json");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("invalid state json");
    expect(test.state).toMatchObject({ status: "failed", phase: "supervisor-state" });
    expect(test.messages).toHaveLength(1);
  });

  it("keeps the installed supervisor until the source version lands", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-supervisor-"));
    const installedPath = NodePath.join(directory, "installed.mjs");
    NodeFS.writeFileSync(installedPath, "installed\n");

    expect(() => refreshInstalledSupervisor(directory, installedPath)).not.toThrow();
    expect(NodeFS.readFileSync(installedPath, "utf8")).toBe("installed\n");

    NodeFS.rmSync(directory, { recursive: true });
  });
});
