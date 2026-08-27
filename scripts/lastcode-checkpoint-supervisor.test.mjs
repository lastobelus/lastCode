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

  it("delivers every distinct blocker after thread delivery recovers", () => {
    const first = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("first fetch blocker");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("first fetch blocker");

    const second = fixture({
      state: first.state,
      dependencies: {
        runPhase: () => {
          throw new Error("second fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("second fetch blocker");

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]?.message).not.toBe(second.messages[1]?.message);
    expect(second.state.pendingIncidents).toBeUndefined();
    expect(second.state.pendingResolutions).toHaveLength(1);
    expect(second.state.incident).toMatchObject({ alertDelivery: "sent" });

    const recovered = fixture({ state: second.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages.every(({ message }) => message.includes("resolved alert"))).toBe(
      true,
    );
    expect(recovered.state.pendingResolutions).toBeUndefined();
  });

  it("closes every delivered blocker after distinct failures recover", () => {
    const first = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("first fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("first fetch blocker");

    const second = fixture({
      state: first.state,
      dependencies: {
        runPhase: () => {
          throw new Error("second fetch blocker");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("second fetch blocker");
    expect(second.state.pendingResolutions).toHaveLength(1);

    const recovered = fixture({ state: second.state });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages.every(({ message }) => message.includes("resolved alert"))).toBe(
      true,
    );
    expect(recovered.messages[0]?.message).not.toBe(recovered.messages[1]?.message);
    expect(recovered.state.pendingResolutions).toBeUndefined();
    expect(recovered.state.incident).toMatchObject({ resolutionDelivery: "sent" });
  });

  it("reuses a queued incident when alternating blockers return", () => {
    const failWith = (message) => () => {
      throw new Error(message);
    };
    const first = fixture({ dependencies: { runPhase: failWith("blocker A") } });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("blocker A");

    const second = fixture({
      state: first.state,
      dependencies: { runPhase: failWith("blocker B") },
    });
    expect(() => runCheckpointSupervisor({}, second.dependencies)).toThrow("blocker B");

    const third = fixture({
      state: second.state,
      dependencies: { runPhase: failWith("blocker A") },
    });
    expect(() => runCheckpointSupervisor({}, third.dependencies)).toThrow("blocker A");
    expect(third.messages).toEqual([]);
    expect(third.state.pendingResolutions).toHaveLength(1);

    const recovered = fixture({ state: third.state });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages[0]?.message).not.toBe(recovered.messages[1]?.message);
    expect(recovered.state.pendingResolutions).toBeUndefined();
  });

  it("retains an undelivered closure when a later run fails", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("blocker A");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("blocker A");

    const recoveredWithoutDelivery = fixture({
      state: failed.state,
      dependencies: {
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    runCheckpointSupervisor({}, recoveredWithoutDelivery.dependencies);
    expect(recoveredWithoutDelivery.state).toMatchObject({
      status: "success",
      incident: { resolutionDelivery: "pending" },
    });

    const failedAgain = fixture({
      state: recoveredWithoutDelivery.state,
      dependencies: {
        runPhase: () => {
          throw new Error("blocker B");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failedAgain.dependencies)).toThrow("blocker B");
    expect(failedAgain.messages).toHaveLength(1);
    expect(failedAgain.state.pendingResolutions).toHaveLength(1);

    const finallyRecovered = fixture({ state: failedAgain.state });
    runCheckpointSupervisor({}, finallyRecovered.dependencies);
    expect(finallyRecovered.messages).toHaveLength(2);
    expect(
      finallyRecovered.messages.every(({ message }) => message.includes("resolved alert")),
    ).toBe(true);
    expect(finallyRecovered.state.pendingResolutions).toBeUndefined();
  });

  it("reopens recurring incidents when no recovery thread is configured", () => {
    const runPhase = () => {
      throw new Error("fetch failed");
    };
    const first = fixture({
      dependencies: { loadConfig: () => null, runPhase },
    });
    expect(() => runCheckpointSupervisor({}, first.dependencies)).toThrow("fetch failed");
    expect(first.dependencies.notify).toHaveBeenCalledOnce();

    const recovered = fixture({
      state: first.state,
      dependencies: { loadConfig: () => null },
    });
    runCheckpointSupervisor({}, recovered.dependencies);
    expect(recovered.state).toMatchObject({
      status: "success",
      incident: { alertDelivery: "not-needed", resolutionDelivery: "not-needed" },
    });
    expect(recovered.state.pendingIncidents).toBeUndefined();

    const recurring = fixture({
      state: recovered.state,
      dependencies: { loadConfig: () => null, runPhase },
    });
    expect(() => runCheckpointSupervisor({}, recurring.dependencies)).toThrow("fetch failed");
    expect(recurring.dependencies.notify).toHaveBeenCalledOnce();
    expect(recurring.state.incident).toMatchObject({ alertDelivery: "pending" });
  });

  it("updates a queued closure with the delayed alert destination", () => {
    const failed = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("blocker A");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failed.dependencies)).toThrow("blocker A");

    const recoveredWithoutDelivery = fixture({
      state: failed.state,
      dependencies: {
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    runCheckpointSupervisor({}, recoveredWithoutDelivery.dependencies);

    const failedAgain = fixture({
      state: recoveredWithoutDelivery.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-delivery" }),
        runPhase: () => {
          throw new Error("blocker B");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, failedAgain.dependencies)).toThrow("blocker B");
    expect(failedAgain.state.pendingResolutions).toHaveLength(1);
    expect(failedAgain.state.pendingResolutions[0]).toMatchObject({
      deliveryThreadId: "thread-delivery",
    });

    const finallyRecovered = fixture({
      state: failedAgain.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });
    runCheckpointSupervisor({}, finallyRecovered.dependencies);
    expect(finallyRecovered.messages).toHaveLength(2);
    expect(finallyRecovered.messages.every(({ threadId }) => threadId === "thread-delivery")).toBe(
      true,
    );
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

  it("sends an incident closure to the thread that received its alert", () => {
    const previous = fixture({
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-original" }),
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");
    expect(previous.state.incident).toMatchObject({
      alertDelivery: "sent",
      deliveryThreadId: "thread-original",
    });

    const recovered = fixture({
      state: previous.state,
      dependencies: {
        loadConfig: () => ({ schemaVersion: 1, recoveryThreadId: "thread-replacement" }),
      },
    });
    runCheckpointSupervisor({}, recovered.dependencies);

    expect(recovered.messages).toHaveLength(1);
    expect(recovered.messages[0]).toMatchObject({ threadId: "thread-original" });
    expect(recovered.messages[0]?.message).toContain("maintenance resolved alert");
  });

  it("delivers the alert and closure when recovery precedes the alert retry", () => {
    const previous = fixture({
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
        sendThread: () => {
          throw new Error("server unavailable");
        },
      },
    });
    expect(() => runCheckpointSupervisor({}, previous.dependencies)).toThrow("fetch failed");

    const recovered = fixture({ state: previous.state });
    expect(runCheckpointSupervisor({}, recovered.dependencies)).toMatchObject({
      status: "success",
      incident: { resolutionDelivery: "sent" },
    });
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages[0]?.message).toContain("maintenance alert");
    expect(recovered.messages[1]?.message).toContain("maintenance resolved alert");
    expect(recovered.state.pendingIncidents).toBeUndefined();
  });

  it("ignores a malformed durable incident backlog", () => {
    const test = fixture({
      state: { schemaVersion: 1, status: "success", pendingIncidents: "invalid" },
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("fetch failed");
    expect(test.messages).toHaveLength(1);
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent" },
    });
  });

  it("discards malformed records inside durable incident state", () => {
    const test = fixture({
      state: {
        schemaVersion: 1,
        status: "success",
        pendingIncidents: ["invalid", { fingerprint: "missing-failure" }],
        pendingResolutions: [null, 42],
        incident: "invalid",
      },
      dependencies: {
        runPhase: () => {
          throw new Error("fetch failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("fetch failed");
    expect(test.messages).toHaveLength(1);
    expect(test.state.pendingIncidents).toBeUndefined();
    expect(test.state.pendingResolutions).toBeUndefined();
    expect(test.state).toMatchObject({
      status: "failed",
      incident: { alertDelivery: "sent" },
    });
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

  it("does not enrich a checkpoint failure with stale history", () => {
    const stale = {
      status: "failed",
      upstreamTag: "v0.0.35-nightly.stale",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.stale",
      error: "old smoke failure",
    };
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => stale,
        retainedRecoveryMatches: () => false,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("current planning failure");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "current planning failure",
    );
    expect(test.state.incident.failure).toMatchObject({ checkpointRun: null });
    expect(test.messages[0]?.message).not.toContain("v0.0.35-nightly.stale");
  });

  it("uses a checkpoint history record written by the current invocation", () => {
    const stale = { status: "failed", upstreamTag: "stale", error: "old failure" };
    const current = { status: "failed", upstreamTag: "current", error: "current failure" };
    const latestFailedCheckpointRun = vi
      .fn()
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(current);
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun,
        retainedRecoveryMatches: () => false,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("checkpoint failed");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow("checkpoint failed");
    expect(test.state.incident.failure.checkpointRun).toEqual(current);
  });

  it("uses unchanged history only for the matching retained recovery", () => {
    const retained = {
      status: "failed",
      upstreamTag: "v0.0.35-nightly.retained",
      recoveryBranch: "sync/nightly/v0.0.35-nightly.retained",
      error: "retained smoke failure",
    };
    const test = fixture({
      dependencies: {
        latestFailedCheckpointRun: () => retained,
        retainedRecoveryMatches: () => true,
        runPhase: (phase) => {
          if (phase === "checkpoint") throw new Error("retained worktree blocks retry");
        },
      },
    });

    expect(() => runCheckpointSupervisor({}, test.dependencies)).toThrow(
      "retained worktree blocks retry",
    );
    expect(test.state.incident.failure.checkpointRun).toEqual(retained);
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
