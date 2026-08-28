#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Host launchd setup uses the platform filesystem and process APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const LABEL = "codes.lastobelus.lastcode-nightly-checkpoint";
const SUPERVISOR_FILE = "lastcode-checkpoint-supervisor.mjs";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(input: {
  readonly intervalSeconds: number;
  readonly logDirectory: string;
  readonly nodePath: string;
  readonly repoRoot: string;
  readonly supervisorPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.nodePath)}</string>
    <string>${xml(input.supervisorPath)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${input.intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(input.logDirectory, "nightly-checkpoint.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(input.logDirectory, "nightly-checkpoint.stderr.log"))}</string>
</dict>
</plist>
`;
}

export function parseNightlyServiceArgs(argv: ReadonlyArray<string>): {
  readonly command: "install" | "run-now" | "status" | "uninstall";
  readonly clearRecoveryThread?: boolean;
  readonly intervalSeconds?: number;
  readonly recoveryThreadId?: string;
} {
  const command = argv[0];
  if (
    command !== "install" &&
    command !== "run-now" &&
    command !== "status" &&
    command !== "uninstall"
  ) {
    throw new Error(
      "Usage: pnpm lastcode:checkpoint:service install --interval-seconds <seconds> [--recovery-thread <thread-id> | --no-recovery-thread] | <run-now|status|uninstall>",
    );
  }
  if (command !== "install") {
    if (argv.length !== 1) {
      throw new Error("Install options are accepted only by the install command.");
    }
    return { command } as const;
  }
  let clearRecoveryThread = false;
  let intervalSeconds: number | undefined;
  let recoveryThreadId: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
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
    if (option === "--recovery-thread") {
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
      if (clearRecoveryThread || recoveryThreadId !== undefined) {
        throw new Error("Configure either one recovery thread or no recovery thread.");
      }
      clearRecoveryThread = true;
      continue;
    }
    throw new Error(`Unknown install option '${option}'.`);
  }
  if (intervalSeconds === undefined) {
    throw new Error("install requires --interval-seconds from deployment configuration.");
  }
  return {
    command,
    intervalSeconds,
    ...(clearRecoveryThread ? { clearRecoveryThread: true } : {}),
    ...(recoveryThreadId ? { recoveryThreadId } : {}),
  } as const;
}

export function runNowArguments(service: string): ReadonlyArray<string> {
  return ["kickstart", service];
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
  if (Effect.runSync(HostProcessPlatform) !== "darwin")
    throw new Error("LastCode nightly scheduling requires macOS launchd.");
  const { clearRecoveryThread, command, intervalSeconds, recoveryThreadId } =
    parseNightlyServiceArgs(argv);

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
  const home = NodeOS.homedir();
  const plistPath = NodePath.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const logDirectory = NodePath.join(home, ".lastcode", "automation");
  const supervisorDirectory = NodePath.join(logDirectory, "bin");
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
    run("launchctl", runNowArguments(service));
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
    return;
  }
  if (intervalSeconds === undefined) {
    throw new Error("Install interval was not resolved from deployment configuration.");
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
  if (clearRecoveryThread) {
    if (NodeFS.existsSync(supervisorConfigPath)) NodeFS.rmSync(supervisorConfigPath);
  } else if (recoveryThreadId) {
    const temporaryConfigPath = `${supervisorConfigPath}.tmp`;
    NodeFS.writeFileSync(
      temporaryConfigPath,
      `${JSON.stringify({ schemaVersion: 1, recoveryThreadId }, null, 2)}\n`,
      { mode: 0o600 },
    );
    NodeFS.renameSync(temporaryConfigPath, supervisorConfigPath);
  }
  NodeFS.writeFileSync(
    plistPath,
    renderLaunchAgentPlist({
      intervalSeconds,
      logDirectory,
      nodePath: process.execPath,
      repoRoot: automationWorktree,
      supervisorPath,
    }),
  );
  run("plutil", ["-lint", plistPath]);
  run("launchctl", ["bootout", service], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["kickstart", service]);
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
