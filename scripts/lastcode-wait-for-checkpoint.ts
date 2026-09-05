#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- Host-side supervisor observation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { lastCodeAction } from "./lib/lastcode-action-kit.ts";

export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
export const POLL_INTERVAL_MS = 10_000;
export const SERVICE_LABEL = "codes.lastobelus.lastcode-nightly-checkpoint";

export type SupervisorState = {
  readonly schemaVersion: 1;
  readonly status: "failed" | "success";
  readonly phase: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly incident?: { readonly fingerprint?: string; readonly failure?: Record<string, unknown> };
};

export class CheckpointWaitError extends Error {
  readonly reason: "not-running" | "probe-failed" | "run-replaced" | "no-state" | "timeout";
  constructor(reason: CheckpointWaitError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export type DaemonStatus = {
  readonly state: "running" | "idle" | "unavailable";
  readonly pid?: number;
  readonly lastExit?: string;
  readonly runs?: number;
};

export type WaitDependencies = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readState: () => SupervisorState | null;
  readonly daemonStatus: () => DaemonStatus;
  readonly progress?: (input: {
    readonly state: "working" | "waiting";
    readonly phase: string;
    readonly summary: string;
  }) => void;
};

function validState(value: unknown): value is SupervisorState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const started = typeof state.startedAt === "string" ? Date.parse(state.startedAt) : Number.NaN;
  const finished = typeof state.finishedAt === "string" ? Date.parse(state.finishedAt) : Number.NaN;
  return (
    state.schemaVersion === 1 &&
    (state.status === "success" || state.status === "failed") &&
    typeof state.phase === "string" &&
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    new Date(started).toISOString() === state.startedAt &&
    new Date(finished).toISOString() === state.finishedAt &&
    finished >= started &&
    (state.status !== "success" || state.phase === "complete")
  );
}

export function readSupervisorState(home = NodeOS.homedir()): SupervisorState | null {
  const path = NodePath.join(home, ".lastcode", "automation", "checkpoint-service-state.json");
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return validState(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseDaemonStatus(output: string, exitCode = 0, error = false): DaemonStatus {
  if (error || exitCode !== 0) return { state: "unavailable" };
  const state = /^\s*state = (.+)$/mu.exec(output)?.[1]?.trim();
  const pidText = /^\s*pid = (\d+)$/mu.exec(output)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/mu.exec(output)?.[1]?.trim();
  const runsText = /^\s*runs = (\d+)$/mu.exec(output)?.[1];
  if (state !== "running" && state !== "not running") return { state: "unavailable" };
  return {
    state: state === "running" ? "running" : "idle",
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(lastExit ? { lastExit } : {}),
    ...(runsText ? { runs: Number(runsText) } : {}),
  };
}

function daemonStatus(): DaemonStatus {
  const result = NodeChildProcess.spawnSync(
    "launchctl",
    ["print", `gui/${NodeOS.userInfo().uid}/${SERVICE_LABEL}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    },
  );
  return parseDaemonStatus(result.stdout ?? "", result.status ?? 1, Boolean(result.error));
}

function terminalChanged(previous: SupervisorState | null, current: SupervisorState): boolean {
  if (!previous) return true;
  return current.finishedAt !== previous.finishedAt || current.startedAt !== previous.startedAt;
}

export async function waitForCheckpoint(
  deps: WaitDependencies,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SupervisorState> {
  const baseline = deps.readState();
  const observedAt = deps.now();
  const initialDaemon = deps.daemonStatus();
  if (initialDaemon.state === "unavailable") {
    throw new CheckpointWaitError(
      "probe-failed",
      "Could not observe the checkpoint supervisor with launchctl.",
    );
  }
  if (initialDaemon.state !== "running" || initialDaemon.pid === undefined) {
    throw new CheckpointWaitError(
      "not-running",
      `No active checkpoint supervisor run is observable (state=${initialDaemon.state}, pid=${initialDaemon.pid ?? "—"}).`,
    );
  }
  const pid = initialDaemon.pid;
  const initialRuns = initialDaemon.runs;
  const started = deps.now();
  let previousProgress = "";
  while (true) {
    const currentDaemon = deps.daemonStatus();
    const currentState = deps.readState();
    if (currentDaemon.state === "unavailable") {
      throw new CheckpointWaitError(
        "probe-failed",
        "Checkpoint supervisor observation became unavailable.",
      );
    }
    if (currentDaemon.state === "running" && currentDaemon.pid !== pid) {
      throw new CheckpointWaitError(
        "run-replaced",
        `Checkpoint supervisor run ${pid} was replaced by run ${currentDaemon.pid ?? "unknown"}.`,
      );
    }
    if (initialRuns !== undefined && currentDaemon.runs !== initialRuns) {
      throw new CheckpointWaitError(
        "run-replaced",
        `Checkpoint supervisor run ${pid} cannot be matched to its original launch count.`,
      );
    }
    const daemonExited = currentDaemon.state === "idle";
    if (daemonExited) {
      if (!validState(currentState) || !terminalChanged(baseline, currentState)) {
        throw new CheckpointWaitError(
          "no-state",
          `Checkpoint supervisor run ${pid} exited without a new terminal state.`,
        );
      }
      if (Date.parse(currentState.finishedAt) < observedAt) {
        throw new CheckpointWaitError(
          "no-state",
          `Checkpoint supervisor run ${pid} exposed only a preexisting terminal state.`,
        );
      }
      return currentState;
    }
    if (deps.now() - started >= timeoutMs) {
      throw new CheckpointWaitError(
        "timeout",
        `Checkpoint supervisor run ${pid} did not reach a terminal state within ${timeoutMs}ms.`,
      );
    }
    const phase = "checkpoint-service";
    const summary = `Waiting for checkpoint supervisor run ${pid} to finish`;
    const key = `${phase}:${summary}`;
    if (key !== previousProgress) {
      deps.progress?.({ state: "waiting", phase, summary });
      previousProgress = key;
    }
    await deps.sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - (deps.now() - started)));
  }
}

export function reportCheckpointResult(state: SupervisorState): void {
  const fingerprint = state.incident?.fingerprint;
  const diagnostic = state.incident?.failure?.diagnostic ?? state.incident?.failure?.error;
  lastCodeAction.result({
    outcome: state.status === "success" ? "success" : "attention",
    reason: state.status === "success" ? "completed" : "failed",
    summary:
      state.status === "success"
        ? "Checkpoint supervisor completed successfully"
        : `Checkpoint supervisor failed during ${state.phase}`,
    subject: { type: "checkpoint", id: state.finishedAt, revision: state.startedAt },
    facts: {
      status: state.status,
      phase: state.phase,
      ...(typeof fingerprint === "string" && fingerprint.trim()
        ? { fingerprint: fingerprint.trim().slice(0, 500) }
        : {}),
      ...(state.status === "failed" && typeof diagnostic === "string" && diagnostic.trim()
        ? { diagnostic: diagnostic.trim().slice(0, 500) }
        : {}),
    },
  });
}

export function parseOptions(argv: ReadonlyArray<string>): {
  readonly home?: string;
  readonly timeoutMs: number;
} {
  let home: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--home") {
      home = argv[++i];
      if (!home) throw new Error("--home requires a path.");
    } else if (argv[i] === "--timeout-ms") {
      const value = argv[++i];
      if (!value) throw new Error("--timeout-ms requires a value.");
      timeoutMs = Number(value);
    } else throw new Error("Usage: lastcode-wait-for-checkpoint [--home PATH] [--timeout-ms MS]");
  }
  if (timeoutMs <= 0 || !Number.isSafeInteger(timeoutMs))
    throw new Error("--timeout-ms must be a positive integer.");
  return { ...(home ? { home } : {}), timeoutMs };
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const state = await waitForCheckpoint(
      {
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        readState: () => readSupervisorState(options.home),
        daemonStatus,
        progress: (value) => lastCodeAction.progress(value),
      },
      options.timeoutMs,
    );
    reportCheckpointResult(state);
  } catch (error) {
    if (error instanceof CheckpointWaitError) {
      lastCodeAction.result({ outcome: "attention", reason: error.reason, summary: error.message });
    }
    console.error(
      `[wait-for-checkpoint] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
