#!/usr/bin/env node

// Standalone wall-clock gate for daily LastCode checkpoints. launchd has no
// per-calendar-trigger time zone, so the installed helper resolves the target
// wall clock itself and runs the supervisor at most once per local date.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const RUN_NOW_REQUEST_FILE = "checkpoint-schedule-run-now.request";
const SCHEDULE_STATE_FILE = "checkpoint-schedule-state.json";
const SUPERVISOR_FILE = "lastcode-checkpoint-supervisor.mjs";

function readJson(path, label) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw new Error(
      `Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, path);
}

export function parseCheckpointScheduleArgs(argv) {
  if (argv[0] !== "run") {
    throw new Error(
      "Usage: lastcode-checkpoint-schedule.mjs run --daily-at <HH:MM> --time-zone <IANA-zone>",
    );
  }
  let dailyAt;
  let timeZone;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--daily-at") {
      const value = argv[index + 1];
      if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
        throw new Error("--daily-at requires a 24-hour HH:MM time.");
      }
      dailyAt = value;
      index += 1;
      continue;
    }
    if (option === "--time-zone") {
      const value = argv[index + 1];
      if (!value) throw new Error("--time-zone requires an IANA time zone.");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
      } catch {
        throw new Error("--time-zone requires an IANA time zone.");
      }
      timeZone = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown schedule option '${option}'.`);
  }
  if (!dailyAt || !timeZone) {
    throw new Error("Daily scheduling requires both --daily-at and --time-zone.");
  }
  return { dailyAt, timeZone };
}

export function wallClockAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  if (!year || !month || !day || !hour || !minute) {
    throw new Error(`Could not resolve the current wall clock in ${timeZone}.`);
  }
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

export function dailyCheckpointDecision({ dailyAt, forced, instant, state, timeZone }) {
  const wallClock = wallClockAt(instant, timeZone);
  if (forced) {
    return {
      localDate: wallClock.date,
      reason: "manual",
      run: true,
      satisfiesSchedule: wallClock.time >= dailyAt,
    };
  }
  if (wallClock.time < dailyAt || state?.lastAttemptedLocalDate === wallClock.date) {
    return { localDate: wallClock.date, reason: "not-due", run: false };
  }
  return { localDate: wallClock.date, reason: "scheduled", run: true };
}

export function checkpointSchedulePaths(moduleUrl = import.meta.url) {
  const binDirectory = NodePath.dirname(NodeURL.fileURLToPath(moduleUrl));
  const rootDirectory = NodePath.dirname(binDirectory);
  return {
    requestPath: NodePath.join(rootDirectory, RUN_NOW_REQUEST_FILE),
    statePath: NodePath.join(rootDirectory, SCHEDULE_STATE_FILE),
    supervisorPath: NodePath.join(binDirectory, SUPERVISOR_FILE),
  };
}

export function runCheckpointSchedule(options, overrides = {}) {
  const paths = checkpointSchedulePaths();
  const dependencies = {
    instant: () => new Date(),
    requestExists: () => NodeFS.existsSync(paths.requestPath),
    readState: () => readJson(paths.statePath, "checkpoint schedule state"),
    removeRequest: () => NodeFS.rmSync(paths.requestPath, { force: true }),
    runSupervisor: () => {
      const result = NodeChildProcess.spawnSync(process.execPath, [paths.supervisorPath, "run"], {
        cwd: process.cwd(),
        env: { ...process.env, LASTCODE_CHECKPOINT_SCHEDULER_PID: String(process.pid) },
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Checkpoint supervisor failed with ${result.status ?? "unknown"}.`);
      }
    },
    writeState: (state) => writeJsonAtomic(paths.statePath, state),
    ...overrides,
  };
  const forced = dependencies.requestExists();
  const decision = dailyCheckpointDecision({
    ...options,
    forced,
    instant: dependencies.instant(),
    state: dependencies.readState(),
  });
  if (!decision.run) return decision;
  if (forced) dependencies.removeRequest();
  if (!forced || decision.satisfiesSchedule) {
    dependencies.writeState({
      schemaVersion: 1,
      lastAttemptedLocalDate: decision.localDate,
    });
  }
  dependencies.runSupervisor();
  return decision;
}

if (import.meta.main) {
  try {
    const options = parseCheckpointScheduleArgs(process.argv.slice(2));
    runCheckpointSchedule(options);
  } catch (error) {
    console.error(
      `[lastcode:checkpoint-schedule] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
