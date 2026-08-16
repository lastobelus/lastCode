#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Host launchd setup uses the platform filesystem and process APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const LABEL = "codes.lastobelus.lastcode-nightly-checkpoint";
const INTERVAL_SECONDS = 60 * 60;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(input: {
  readonly logDirectory: string;
  readonly repoRoot: string;
}): string {
  const command = [
    "git fetch origin +refs/heads/lastcode/main:refs/remotes/origin/lastcode/main",
    "&amp;&amp; git checkout --detach --force refs/remotes/origin/lastcode/main",
    "&amp;&amp; ./node_modules/.bin/vp install --frozen-lockfile",
    "&amp;&amp;",
    "mise exec node@24.13.1 -- node scripts/lastcode-checkpoint.ts",
    "--push-tags",
    "--promote-if-no-open-prs",
    "--mirror-upstream-main",
  ].join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${command}</string>
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
  <integer>${INTERVAL_SECONDS}</integer>
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
  const command = argv[0];
  if (
    !command ||
    argv.length !== 1 ||
    !["install", "run-now", "status", "uninstall"].includes(command)
  ) {
    throw new Error("Usage: pnpm lastcode:checkpoint:service <install|run-now|status|uninstall>");
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
  const home = NodeOS.homedir();
  const plistPath = NodePath.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const logDirectory = NodePath.join(home, ".lastcode", "automation");
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
    return;
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
  NodeFS.writeFileSync(
    plistPath,
    renderLaunchAgentPlist({ logDirectory, repoRoot: automationWorktree }),
  );
  run("plutil", ["-lint", plistPath]);
  run("launchctl", ["bootout", service], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["kickstart", service]);
  console.log(`[lastcode:service] Installed ${LABEL}; it runs at login and hourly.`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:service] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
