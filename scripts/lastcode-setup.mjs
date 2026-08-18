#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const CANONICAL_UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

export function parseOptions(argv) {
  let dryRun = false;
  let enableNightlyWrites = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--enable-nightly-writes") enableNightlyWrites = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else throw new Error(`Unknown argument '${arg}'.`);
  }

  return { dryRun, enableNightlyWrites, help };
}

export function isCanonicalUpstreamUrl(value) {
  return /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:pingdotgg\/t3code)(?:\.git)?\/?$/.test(
    value,
  );
}

export function setupCommands(repoRoot, nodeExecutable = process.execPath) {
  return [
    { command: "vp", args: ["install", "--frozen-lockfile"], cwd: repoRoot },
    {
      command: nodeExecutable,
      args: [NodePath.join(repoRoot, "scripts", "lastcode-nightly-service.ts"), "install"],
      cwd: repoRoot,
    },
    {
      command: nodeExecutable,
      args: [NodePath.join(repoRoot, "scripts", "lastcode-checkpoints.mjs"), "--install"],
      cwd: repoRoot,
    },
    {
      command: nodeExecutable,
      args: [NodePath.join(repoRoot, "scripts", "lastcode-build.mjs"), "--install"],
      cwd: repoRoot,
    },
    {
      command: nodeExecutable,
      args: [NodePath.join(repoRoot, "scripts", "lastcode-install.mjs"), "--install"],
      cwd: repoRoot,
    },
  ];
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() || result.stdout.trim() : "";
    throw new Error(detail || `${command} ${args.join(" ")} failed with ${result.status}.`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function commandExists(command) {
  const result = NodeChildProcess.spawnSync("/usr/bin/which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function shellDisplay(command, args) {
  return [command, ...args]
    .map((value) => (/^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");
}

function ensureUpstreamRemote(repoRoot, dryRun) {
  const remotes = new Set(
    run("git", ["remote"], { cwd: repoRoot, capture: true }).split(/\r?\n/).filter(Boolean),
  );
  if (!remotes.has("origin")) throw new Error("This checkout does not have an origin remote.");

  if (!remotes.has("upstream")) {
    if (dryRun) {
      console.log(`git remote add upstream ${CANONICAL_UPSTREAM_URL}`);
    } else {
      run("git", ["remote", "add", "upstream", CANONICAL_UPSTREAM_URL], { cwd: repoRoot });
    }
    return;
  }

  const upstreamUrl = run("git", ["remote", "get-url", "upstream"], {
    cwd: repoRoot,
    capture: true,
  });
  if (!isCanonicalUpstreamUrl(upstreamUrl)) {
    throw new Error(
      `Expected upstream to point at pingdotgg/t3code, found '${upstreamUrl}'. Resolve that remote before setup.`,
    );
  }
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(
      "Usage: mise exec node@24.13.1 -- node scripts/lastcode-setup.mjs --enable-nightly-writes [--dry-run]",
    );
    console.log();
    console.log("Installs LastCode's hourly checkpoint service and managed local-build commands.");
    return;
  }
  const platform = run("/usr/bin/uname", ["-s"], { capture: true });
  const architecture = run("/usr/bin/uname", ["-m"], { capture: true });
  if (platform !== "Darwin" || architecture !== "arm64") {
    throw new Error("LastCode local setup currently requires Apple Silicon macOS.");
  }
  if (!options.enableNightlyWrites) {
    throw new Error(
      "Setup installs an hourly daemon that pushes checkpoint tags and rebased branches to origin. Rerun with --enable-nightly-writes after confirming origin is your writable fork.",
    );
  }

  const repoRoot = run("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    capture: true,
  });
  const missing = ["git", "gh", "mise", "vp", "fzf"].filter((command) => !commandExists(command));
  if (missing.length > 0) {
    throw new Error(`Missing required commands: ${missing.join(", ")}.`);
  }

  ensureUpstreamRemote(repoRoot, options.dryRun);
  console.log("[lastcode:setup] Found origin remote.");
  console.log(
    "[lastcode:setup] This origin must be writable: the installed service updates lastcode/main, main, and lastcode/* tags.",
  );

  if (!options.dryRun) {
    run("gh", ["auth", "status"], { cwd: repoRoot });
    run("git", ["ls-remote", "--exit-code", "origin", "refs/heads/lastcode/main"], {
      cwd: repoRoot,
    });
  }

  for (const step of setupCommands(repoRoot)) {
    if (options.dryRun) console.log(shellDisplay(step.command, step.args));
    else run(step.command, step.args, { cwd: step.cwd });
  }

  if (options.dryRun) return;
  console.log("[lastcode:setup] Setup complete.");
  console.log(
    "[lastcode:setup] Wait for lastcode-checkpoints to show a ready installable, then run:",
  );
  console.log("  lastcode-build");
  console.log("  lastcode-install");
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:setup] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
