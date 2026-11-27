#!/usr/bin/env node
import * as HostProcess from "@t3tools/shared/HostProcess";

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Host launchd setup uses the platform filesystem and process APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  checkpointServiceRunNowArguments,
  checkpointServiceRunNowPaths,
  isDailyCheckpointLaunchAgent,
  LASTCODE_CHECKPOINT_SERVICE_LABEL,
  requestCheckpointServiceRunNow,
} from "./lib/lastcode-checkpoint-service-run-now.mjs";

const LABEL = LASTCODE_CHECKPOINT_SERVICE_LABEL;
const SCHEDULE_FILE = "checkpoint-schedule.json";
const SCHEDULE_HELPER_FILE = "lastcode-checkpoint-schedule.mjs";
const SUPERVISOR_FILE = "lastcode-checkpoint-supervisor.mjs";

export type CheckpointSchedule =
  | { readonly intervalSeconds: number; readonly kind: "interval" }
  | { readonly dailyAt: string; readonly kind: "daily"; readonly timeZone: string };

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validateLauncherPrefix(value: unknown): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (argument): argument is string => typeof argument === "string" && !argument.includes("\0"),
    ) ||
    !NodePath.isAbsolute(value[0] ?? "")
  ) {
    throw new Error(
      "launcherPrefix must be a nonempty string array starting with an absolute executable path; arguments cannot contain NUL.",
    );
  }
  return value;
}

export function renderLaunchAgentPlist(input: {
  readonly launcherPrefix?: ReadonlyArray<string>;
  readonly logDirectory: string;
  readonly nodePath: string;
  readonly repoRoot: string;
  readonly schedule: CheckpointSchedule;
  readonly scheduleHelperPath: string;
  readonly supervisorPath: string;
}): string {
  const commandArguments =
    input.schedule.kind === "interval"
      ? [input.supervisorPath, "run"]
      : [
          input.scheduleHelperPath,
          "run",
          "--daily-at",
          input.schedule.dailyAt,
          "--time-zone",
          input.schedule.timeZone,
        ];
  const programArguments = [
    ...(input.launcherPrefix === undefined ? [] : validateLauncherPrefix(input.launcherPrefix)),
    input.nodePath,
    ...commandArguments,
  ]
    .map((argument) => `<string>${xml(argument)}</string>`)
    .join("\n    ");
  const intervalSeconds = input.schedule.kind === "interval" ? input.schedule.intervalSeconds : 60;
  const runAtLoad = input.schedule.kind === "interval" ? "  <key>RunAtLoad</key>\n  <true/>\n" : "";
  // Background throttles every CI descendant; local CI already limits capacity and priority.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
${runAtLoad}  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(input.logDirectory, "nightly-checkpoint.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(input.logDirectory, "nightly-checkpoint.stderr.log"))}</string>
</dict>
</plist>
`;
}

export function parseNightlyServiceArgs(argv: ReadonlyArray<string>): {
  readonly command: "configure-schedule" | "install" | "run-now" | "status" | "uninstall";
  readonly clearLauncherPrefix?: boolean;
  readonly clearRecoveryThread?: boolean;
  readonly dailyAt?: string;
  readonly ifInstalled?: boolean;
  readonly intervalSeconds?: number;
  readonly launcherPrefix?: ReadonlyArray<string>;
  readonly recoveryThreadId?: string;
  readonly timeZone?: string;
  readonly trustedProjectActionIds?: ReadonlyArray<string>;
} {
  const command = argv[0];
  if (
    command !== "configure-schedule" &&
    command !== "install" &&
    command !== "run-now" &&
    command !== "status" &&
    command !== "uninstall"
  ) {
    throw new Error(
      "Usage: pnpm lastcode:checkpoint:service configure-schedule [--interval-seconds <seconds> | --daily-at <HH:MM> --time-zone <IANA-zone>] [--launcher-prefix-json <JSON> | --clear-launcher-prefix] | install [--interval-seconds <seconds> | --daily-at <HH:MM> --time-zone <IANA-zone>] [--launcher-prefix-json <JSON> | --clear-launcher-prefix] [--recovery-thread <thread-id> | --no-recovery-thread] [--trusted-project-action <lc-id>]... | run-now [--if-installed] | <status|uninstall>",
    );
  }
  if (command !== "install" && command !== "configure-schedule") {
    if (command === "run-now" && argv.length === 2 && argv[1] === "--if-installed") {
      return { command, ifInstalled: true } as const;
    }
    if (argv.length !== 1) {
      throw new Error("Install options are accepted only by the install command.");
    }
    return { command } as const;
  }
  let clearLauncherPrefix = false;
  let clearRecoveryThread = false;
  let dailyAt: string | undefined;
  let intervalSeconds: number | undefined;
  let launcherPrefix: ReadonlyArray<string> | undefined;
  let recoveryThreadId: string | undefined;
  let timeZone: string | undefined;
  const trustedProjectActionIds: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--launcher-prefix-json" || option === "--clear-launcher-prefix") {
      if (clearLauncherPrefix || launcherPrefix !== undefined) {
        throw new Error("Configure either one launcher prefix or --clear-launcher-prefix.");
      }
      if (option === "--clear-launcher-prefix") {
        clearLauncherPrefix = true;
      } else {
        const value = argv[index + 1];
        let parsed: unknown;
        try {
          parsed = JSON.parse(value ?? "");
        } catch {
          throw new Error("--launcher-prefix-json requires valid JSON.");
        }
        launcherPrefix = validateLauncherPrefix(parsed);
        index += 1;
      }
      continue;
    }
    if (option === "--interval-seconds") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("--interval-seconds requires a positive integer.");
      }
      if (intervalSeconds !== undefined) {
        throw new Error("--interval-seconds may be provided only once.");
      }
      intervalSeconds = value;
      index += 1;
      continue;
    }
    if (option === "--daily-at") {
      const value = argv[index + 1];
      if (!value || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
        throw new Error("--daily-at requires a 24-hour HH:MM time.");
      }
      if (dailyAt !== undefined) throw new Error("--daily-at may be provided only once.");
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
      if (timeZone !== undefined) throw new Error("--time-zone may be provided only once.");
      timeZone = value;
      index += 1;
      continue;
    }
    if (option === "--recovery-thread") {
      if (command === "configure-schedule") {
        throw new Error("Recovery options are accepted only by the install command.");
      }
      const value = argv[index + 1];
      if (!value || !/^[A-Za-z0-9-]{8,}$/u.test(value)) {
        throw new Error("--recovery-thread requires a valid thread ID.");
      }
      if (clearRecoveryThread || recoveryThreadId !== undefined) {
        throw new Error("Configure either one recovery thread or no recovery thread.");
      }
      recoveryThreadId = value;
      index += 1;
      continue;
    }
    if (option === "--no-recovery-thread") {
      if (command === "configure-schedule") {
        throw new Error("Recovery options are accepted only by the install command.");
      }
      if (clearRecoveryThread || recoveryThreadId !== undefined) {
        throw new Error("Configure either one recovery thread or no recovery thread.");
      }
      clearRecoveryThread = true;
      continue;
    }
    if (option === "--trusted-project-action") {
      if (command === "configure-schedule") {
        throw new Error("Project Action options are accepted only by the install command.");
      }
      const value = argv[index + 1];
      if (!value || !/^lc-[a-z0-9-]+$/u.test(value)) {
        throw new Error("--trusted-project-action requires a stable lc-* Action id.");
      }
      trustedProjectActionIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown ${command} option '${option}'.`);
  }
  if (intervalSeconds !== undefined && (dailyAt !== undefined || timeZone !== undefined)) {
    throw new Error("Configure either an interval or one daily time, not both.");
  }
  if ((dailyAt === undefined) !== (timeZone === undefined)) {
    throw new Error("A daily schedule requires both --daily-at and --time-zone.");
  }
  if (
    command === "configure-schedule" &&
    intervalSeconds === undefined &&
    dailyAt === undefined &&
    launcherPrefix === undefined &&
    !clearLauncherPrefix
  ) {
    throw new Error(
      "configure-schedule requires an interval or daily schedule, or a launcher prefix change.",
    );
  }
  return {
    command,
    ...(clearLauncherPrefix ? { clearLauncherPrefix: true } : {}),
    ...(launcherPrefix ? { launcherPrefix } : {}),
    ...(dailyAt ? { dailyAt } : {}),
    ...(intervalSeconds ? { intervalSeconds } : {}),
    ...(timeZone ? { timeZone } : {}),
    trustedProjectActionIds: [...new Set(trustedProjectActionIds)].toSorted(),
    ...(clearRecoveryThread ? { clearRecoveryThread: true } : {}),
    ...(recoveryThreadId ? { recoveryThreadId } : {}),
  } as const;
}

export function checkpointScheduleFromConfig(value: unknown): CheckpointSchedule {
  if (!value || typeof value !== "object" || !("schedule" in value)) {
    throw new Error("Checkpoint schedule is missing. Run configure-schedule first.");
  }
  const schedule = value.schedule;
  if (!schedule || typeof schedule !== "object" || !("kind" in schedule)) {
    throw new Error("Checkpoint schedule config is invalid.");
  }
  if (
    schedule.kind === "interval" &&
    "intervalSeconds" in schedule &&
    Number.isSafeInteger(schedule.intervalSeconds) &&
    Number(schedule.intervalSeconds) > 0
  ) {
    return { kind: "interval", intervalSeconds: Number(schedule.intervalSeconds) };
  }
  if (
    schedule.kind === "daily" &&
    "dailyAt" in schedule &&
    typeof schedule.dailyAt === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(schedule.dailyAt) &&
    "timeZone" in schedule &&
    typeof schedule.timeZone === "string"
  ) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone }).format(0);
    } catch {
      throw new Error("Checkpoint schedule config has an invalid IANA time zone.");
    }
    return { kind: "daily", dailyAt: schedule.dailyAt, timeZone: schedule.timeZone };
  }
  throw new Error("Checkpoint schedule config is invalid.");
}

export function nextCheckpointScheduleConfig(
  schedule: CheckpointSchedule | undefined,
  current: unknown,
  options: {
    readonly clearLauncherPrefix?: boolean;
    readonly launcherPrefix?: ReadonlyArray<string>;
  } = {},
): {
  readonly schemaVersion: 1;
  readonly schedule: CheckpointSchedule;
  readonly launcherPrefix?: ReadonlyArray<string>;
} {
  const previous = current && typeof current === "object" ? current : {};
  const launcherPrefix = options.clearLauncherPrefix
    ? undefined
    : options.launcherPrefix !== undefined
      ? validateLauncherPrefix(options.launcherPrefix)
      : "launcherPrefix" in previous
        ? validateLauncherPrefix(previous.launcherPrefix)
        : undefined;
  return {
    schemaVersion: 1,
    schedule: schedule ?? checkpointScheduleFromConfig(current),
    ...(launcherPrefix ? { launcherPrefix } : {}),
  };
}

export function writeJsonAtomic(path: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, path);
}

export function nextCheckpointSupervisorConfig(
  current: unknown,
  options: {
    readonly clearRecoveryThread?: boolean;
    readonly recoveryThreadId?: string;
    readonly trustedProjectActionIds: ReadonlyArray<string>;
  },
): Record<string, unknown> {
  const previous = current && typeof current === "object" ? current : {};
  const previousRecoveryThreadId =
    "recoveryThreadId" in previous && typeof previous.recoveryThreadId === "string"
      ? previous.recoveryThreadId
      : undefined;
  const recoveryThreadId = options.clearRecoveryThread
    ? undefined
    : (options.recoveryThreadId ?? previousRecoveryThreadId);
  return {
    schemaVersion: 1,
    ...(recoveryThreadId ? { recoveryThreadId } : {}),
    ...("postPublishCommand" in previous
      ? { postPublishCommand: previous.postPublishCommand }
      : {}),
    trustedProjectActionIds: [...options.trustedProjectActionIds],
  };
}

export function runNowArguments(service: string): ReadonlyArray<string> {
  return checkpointServiceRunNowArguments(service);
}

export function clearNightlyServiceState(logDirectory: string): void {
  const statePath = NodePath.join(logDirectory, "checkpoint-service-state.json");
  if (NodeFS.existsSync(statePath)) NodeFS.rmSync(statePath);
}

export function shouldRequestRunNow(ifInstalled: boolean, plistExists: boolean): boolean {
  return !ifInstalled || plistExists;
}

export function shouldRunNightlyServiceCommand(
  command: "configure-schedule" | "install" | "run-now" | "status" | "uninstall",
  ifInstalled: boolean,
  platform: string,
): boolean {
  if (command === "configure-schedule") return true;
  if (platform === "darwin") return true;
  if (command === "run-now" && ifInstalled) return false;
  throw new Error("LastCode nightly scheduling requires macOS launchd.");
}

export function isDailyLaunchAgent(plist: string): boolean {
  return isDailyCheckpointLaunchAgent(plist);
}

export function shouldDeferAutomaticRunNow(ifInstalled: boolean, plist: string | null): boolean {
  return ifInstalled && plist !== null && isDailyLaunchAgent(plist);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean; readonly cwd?: string } = {},
): void {
  const result = NodeChildProcess.spawnSync(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status ?? "unknown"}.`);
  }
}

function main(argv: ReadonlyArray<string>): void {
  const {
    clearLauncherPrefix,
    clearRecoveryThread,
    command,
    dailyAt,
    ifInstalled,
    intervalSeconds,
    launcherPrefix,
    recoveryThreadId,
    timeZone,
    trustedProjectActionIds = [],
  } = parseNightlyServiceArgs(argv);
  if (
    !shouldRunNightlyServiceCommand(
      command,
      ifInstalled === true,
      Effect.runSync(HostProcess.Platform),
    )
  )
    return;

  const home = NodeOS.homedir();
  const logDirectory = NodePath.join(home, ".lastcode", "automation");
  const scheduleConfigPath = NodePath.join(logDirectory, SCHEDULE_FILE);
  const configuredSchedule: CheckpointSchedule | undefined = intervalSeconds
    ? { kind: "interval", intervalSeconds }
    : dailyAt && timeZone
      ? { kind: "daily", dailyAt, timeZone }
      : undefined;
  const scheduleConfig =
    command === "install" || command === "configure-schedule"
      ? nextCheckpointScheduleConfig(
          configuredSchedule,
          NodeFS.existsSync(scheduleConfigPath)
            ? (JSON.parse(NodeFS.readFileSync(scheduleConfigPath, "utf8")) as unknown)
            : null,
          {
            ...(clearLauncherPrefix ? { clearLauncherPrefix: true } : {}),
            ...(launcherPrefix ? { launcherPrefix } : {}),
          },
        )
      : undefined;
  if (command === "configure-schedule") {
    writeJsonAtomic(scheduleConfigPath, scheduleConfig);
    console.log(`[lastcode:service] Saved ${scheduleConfigPath}.`);
    console.log("[lastcode:service] The running service was not changed or started.");
    return;
  }

  const repoRoot = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const worktreeList = NodeChildProcess.execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const primaryWorktree = worktreeList
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!primaryWorktree) throw new Error("Could not resolve the repository's primary worktree.");
  const automationWorktree = NodePath.join(
    NodePath.dirname(primaryWorktree),
    `${NodePath.basename(primaryWorktree)}-worktrees`,
    "lastcode-automation",
  );
  const plistPath = NodePath.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const supervisorDirectory = NodePath.join(logDirectory, "bin");
  const scheduleHelperPath = NodePath.join(supervisorDirectory, SCHEDULE_HELPER_FILE);
  const scheduleStatePath = NodePath.join(logDirectory, "checkpoint-schedule-state.json");
  const supervisorPath = NodePath.join(supervisorDirectory, SUPERVISOR_FILE);
  const supervisorConfigPath = NodePath.join(logDirectory, "checkpoint-supervisor.json");
  const getuid = process.getuid;
  if (!getuid) throw new Error("Could not resolve the current macOS user ID.");
  const domain = `gui/${getuid()}`;
  const service = `${domain}/${LABEL}`;

  if (command === "status") {
    run("launchctl", ["print", service]);
    return;
  }
  if (command === "run-now") {
    const result = requestCheckpointServiceRunNow({
      homeDirectory: home,
      uid: getuid(),
      deferDaily: ifInstalled === true,
    });
    if (result.status === "not-installed" && !ifInstalled) {
      throw new Error("The managed checkpoint service is not installed.");
    }
    if (result.status === "deferred") {
      console.log("[lastcode:service] Daily checkpoint schedule retained after merge.");
      return;
    }
    if (result.status === "requested")
      console.log("[lastcode:service] Requested an immediate installable-revision check.");
    return;
  }
  if (command === "uninstall") {
    run("launchctl", ["bootout", service], { allowFailure: true });
    if (NodeFS.existsSync(plistPath)) {
      const backupPath = `${plistPath}.disabled-${new Date().toISOString().replaceAll(":", "-")}`;
      NodeFS.renameSync(plistPath, backupPath);
      console.log(`[lastcode:service] Disabled plist retained at ${backupPath}.`);
    }
    if (NodeFS.existsSync(supervisorConfigPath)) NodeFS.rmSync(supervisorConfigPath);
    const { requestPath, serviceRequestPath } = checkpointServiceRunNowPaths(home);
    for (const pendingRequestPath of [requestPath, serviceRequestPath]) {
      NodeFS.rmSync(pendingRequestPath, { force: true });
    }
    if (NodeFS.existsSync(scheduleStatePath)) NodeFS.rmSync(scheduleStatePath);
    clearNightlyServiceState(logDirectory);
    return;
  }
  if (!scheduleConfig) throw new Error("Schedule configuration was not resolved.");
  const { schedule } = scheduleConfig;
  if (configuredSchedule || launcherPrefix || clearLauncherPrefix) {
    writeJsonAtomic(scheduleConfigPath, scheduleConfig);
  }

  run("git", [
    "-C",
    repoRoot,
    "fetch",
    "origin",
    "+refs/heads/lastcode/main:refs/remotes/origin/lastcode/main",
  ]);
  if (!NodeFS.existsSync(automationWorktree)) {
    NodeFS.mkdirSync(NodePath.dirname(automationWorktree), { recursive: true });
    run("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "--detach",
      automationWorktree,
      "refs/remotes/origin/lastcode/main",
    ]);
  }
  console.log("[lastcode:service] Installing automation worktree dependencies...");
  run(NodePath.join(repoRoot, "node_modules", ".bin", "vp"), ["install", "--frozen-lockfile"], {
    cwd: automationWorktree,
  });
  NodeFS.mkdirSync(NodePath.dirname(plistPath), { recursive: true });
  NodeFS.mkdirSync(logDirectory, { recursive: true });
  NodeFS.mkdirSync(supervisorDirectory, { recursive: true, mode: 0o700 });
  NodeFS.copyFileSync(NodePath.join(repoRoot, "scripts", SUPERVISOR_FILE), supervisorPath);
  NodeFS.chmodSync(supervisorPath, 0o700);
  NodeFS.copyFileSync(NodePath.join(repoRoot, "scripts", SCHEDULE_HELPER_FILE), scheduleHelperPath);
  NodeFS.chmodSync(scheduleHelperPath, 0o700);
  const currentSupervisorConfig = NodeFS.existsSync(supervisorConfigPath)
    ? JSON.parse(NodeFS.readFileSync(supervisorConfigPath, "utf8"))
    : null;
  const nextSupervisorConfig = nextCheckpointSupervisorConfig(currentSupervisorConfig, {
    ...(clearRecoveryThread ? { clearRecoveryThread: true } : {}),
    ...(recoveryThreadId ? { recoveryThreadId } : {}),
    trustedProjectActionIds,
  });
  writeJsonAtomic(supervisorConfigPath, nextSupervisorConfig);
  NodeFS.writeFileSync(
    plistPath,
    renderLaunchAgentPlist({
      ...(scheduleConfig.launcherPrefix ? { launcherPrefix: scheduleConfig.launcherPrefix } : {}),
      logDirectory,
      nodePath: process.execPath,
      repoRoot: automationWorktree,
      schedule,
      scheduleHelperPath,
      supervisorPath,
    }),
  );
  run("plutil", ["-lint", plistPath]);
  run("launchctl", ["bootout", service], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
  if (schedule.kind === "interval") run("launchctl", ["kickstart", service]);
  console.log(`[lastcode:service] Installed managed checkpoint service ${LABEL}.`);
  if (recoveryThreadId) {
    console.log(
      "[lastcode:service] Automatic recovery alerts use the configured maintenance thread.",
    );
  } else if (clearRecoveryThread) {
    console.log("[lastcode:service] Automatic recovery thread delivery is disabled.");
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:service] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
