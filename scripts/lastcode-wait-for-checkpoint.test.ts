// @effect-diagnostics nodeBuiltinImport:off -- Disposable host-side supervisor state fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createActionProtocolDecoder } from "@t3tools/shared/actionResumeProtocol";
import {
  parseDaemonStatus,
  parseOptions,
  readSupervisorState,
  waitForCheckpoint,
  type DaemonStatus,
  type SupervisorState,
} from "./lastcode-wait-for-checkpoint.ts";

const startedAt = "1970-01-01T00:00:00.000Z";
const finishedAt = "1970-01-01T00:00:01.000Z";
const newerFinishedAt = "1970-01-01T00:00:10.000Z";
const success = (finished = finishedAt): SupervisorState => ({
  schemaVersion: 1,
  status: "success",
  phase: "complete",
  startedAt,
  finishedAt: finished,
  supervisorPid: 42,
});

function harness(
  states: ReadonlyArray<SupervisorState | null>,
  daemons: ReadonlyArray<DaemonStatus>,
) {
  let index = 0;
  let now = 0;
  return {
    deps: {
      now: () => now,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
        index += 1;
      },
      readState: () => states[Math.min(index, states.length - 1)] ?? null,
      daemonStatus: () =>
        daemons[Math.min(index, daemons.length - 1)] ?? { state: "idle" as const },
    },
  };
}

function stateFixture(value: unknown): string {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-wait-checkpoint-"));
  onTestFinished(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  const directory = NodePath.join(home, ".lastcode", "automation");
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "checkpoint-service-state.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return home;
}

describe("wait for checkpoint", () => {
  it("parses launchd state, pid, run count, malformed output, and probe failure", () => {
    expect(parseDaemonStatus("state = running\npid = 42\nruns = 3\nlast exit code = 0")).toEqual({
      state: "running",
      pid: 42,
      runs: 3,
      lastExit: "0",
    });
    expect(parseDaemonStatus("garbage")).toEqual({ state: "unavailable" });
    expect(parseDaemonStatus("state = starting")).toEqual({ state: "unavailable" });
    expect(parseDaemonStatus("state = not running\nruns = 3")).toEqual({ state: "idle", runs: 3 });
    expect(parseDaemonStatus("", 1)).toEqual({ state: "unavailable" });
    expect(parseDaemonStatus("", 0, true)).toEqual({ state: "unavailable" });
  });
  it("rejects missing, malformed, invalid-date, wrong-phase, and reversed state fixtures", () => {
    expect(readSupervisorState("/path/that/does/not/exist")).toBeNull();
    for (const value of [
      "not json",
      { ...success(), startedAt: "bad-date" },
      { ...success(), phase: "checkpoint" },
      { ...success(), startedAt: newerFinishedAt, finishedAt },
      { ...success(), supervisorPid: undefined },
      { ...success(), supervisorPid: "42" },
    ])
      expect(readSupervisorState(stateFixture(value))).toBeNull();
  });
  it("waits for the captured pid to exit and accepts a newer terminal state", async () => {
    await expect(
      waitForCheckpoint(
        harness(
          [success(), success(newerFinishedAt)],
          [
            { state: "running", pid: 42 },
            { state: "idle", lastExit: "0" },
          ],
        ).deps,
        30_000,
      ),
    ).resolves.toMatchObject({ finishedAt: newerFinishedAt });
    await expect(
      waitForCheckpoint(
        harness([success(), success()], [{ state: "running", pid: 42 }, { state: "idle" }]).deps,
        30_000,
      ),
    ).resolves.toMatchObject({ finishedAt });
  });
  it("does not attribute old state while running or a different supervisor run", async () => {
    await expect(
      waitForCheckpoint(
        harness(
          [success(), success(), success(newerFinishedAt)],
          [{ state: "running", pid: 42 }, { state: "running", pid: 42 }, { state: "idle" }],
        ).deps,
        30_000,
      ),
    ).resolves.toMatchObject({ finishedAt: newerFinishedAt });
    await expect(
      waitForCheckpoint(
        harness(
          [success(), { ...success(newerFinishedAt), supervisorPid: 41 }],
          [{ state: "running", pid: 42 }, { state: "idle" }],
        ).deps,
        30_000,
      ),
    ).rejects.toThrow("matching terminal state");
  });
  it("rejects idle, missing-pid, timeout, missing state, and mismatched terminal state", async () => {
    await expect(
      waitForCheckpoint(harness([success()], [{ state: "idle" }]).deps, 1),
    ).rejects.toThrow("No active");
    await expect(
      waitForCheckpoint(harness([success()], [{ state: "running" }]).deps, 1),
    ).rejects.toThrow("No active");
    await expect(
      waitForCheckpoint(harness([success()], [{ state: "running", pid: 42 }]).deps, 10_000),
    ).rejects.toThrow("did not reach");
    await expect(
      waitForCheckpoint(
        harness([null], [{ state: "running", pid: 42 }, { state: "idle" }]).deps,
        30_000,
      ),
    ).rejects.toThrow("without");
    await expect(
      waitForCheckpoint(
        harness(
          [success(), { ...success(), supervisorPid: 41 }],
          [{ state: "running", pid: 42 }, { state: "idle" }],
        ).deps,
        30_000,
      ),
    ).rejects.toThrow("matching terminal state");
  });
  it("rejects initial and mid-run probe failure, replacement pid, and superseding run count", async () => {
    await expect(
      waitForCheckpoint(harness([success()], [{ state: "unavailable" }]).deps, 1),
    ).rejects.toThrow("Could not observe");
    await expect(
      waitForCheckpoint(
        harness([success(), success()], [{ state: "running", pid: 42 }, { state: "unavailable" }])
          .deps,
        30_000,
      ),
    ).rejects.toThrow("became unavailable");
    await expect(
      waitForCheckpoint(
        harness(
          [success(), success()],
          [
            { state: "running", pid: 42 },
            { state: "running", pid: 43 },
          ],
        ).deps,
        30_000,
      ),
    ).rejects.toThrow("replaced");
    await expect(
      waitForCheckpoint(
        harness(
          [success(), success(newerFinishedAt)],
          [
            { state: "running", pid: 42, runs: 2 },
            { state: "idle", runs: 3 },
          ],
        ).deps,
        30_000,
      ),
    ).rejects.toThrow("launch count");
  });
  it("returns failure and propagates cancellation without touching the daemon", async () => {
    const failed: SupervisorState = {
      ...success(newerFinishedAt),
      status: "failed",
      phase: "checkpoint",
      supervisorPid: 42,
    };
    await expect(
      waitForCheckpoint(
        harness([success(), failed], [{ state: "running", pid: 42 }, { state: "idle" }]).deps,
        30_000,
      ),
    ).resolves.toMatchObject({ status: "failed" });
    const cancelled = harness([success()], [{ state: "running", pid: 42 }]);
    cancelled.deps.sleep = async () => {
      throw new Error("cancelled");
    };
    await expect(waitForCheckpoint(cancelled.deps, 30_000)).rejects.toThrow("cancelled");
  });
  it("requires values for CLI options", () => {
    expect(() => parseOptions(["--home"])).toThrow("requires a path");
    expect(() => parseOptions(["--timeout-ms"])).toThrow("requires a value");
  });

  it("emits one attention result and exits successfully when no run is active", async () => {
    const home = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-wait-checkpoint-cli-"),
    );
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const launchctl = NodePath.join(bin, "launchctl");
    NodeFS.writeFileSync(launchctl, "#!/bin/sh\nprintf 'state = not running\\n'\n");
    NodeFS.chmodSync(launchctl, 0o755);
    onTestFinished(() => NodeFS.rmSync(home, { recursive: true, force: true }));

    const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
    const runId = "checkpoint-cli-test-run";
    const token = "checkpoint-cli-test-token";
    const result = await execFile(
      process.execPath,
      [NodePath.join(import.meta.dirname, "lastcode-wait-for-checkpoint.ts")],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          T3CODE_ACTION_RUN_ID: runId,
          T3CODE_ACTION_EVENT_TOKEN: token,
        },
      },
    );
    const decoder = createActionProtocolDecoder({ runId, token });
    const decoded = decoder.push(result.stdout);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({
      kind: "result",
      report: { outcome: "attention", reason: "not-running" },
    });
    expect(decoder.finish()).toBe("");
  });
});
