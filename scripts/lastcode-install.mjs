#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

const APP_BUNDLE_ID = "codes.lastobelus.lastcode";
const DEFAULT_APP_PATH = "/Applications/LastCode.app";
const INSTALL_LOCK_NAME = "install.lock";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderLauncher(modulePath) {
  return `#!/bin/sh\nexec mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
}

export function parseOptions(argv) {
  let artifactsDirectory;
  let dmgPath;
  let install = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
    else if (arg === "--artifacts") {
      artifactsDirectory = argv[index + 1];
      if (!artifactsDirectory) throw new Error("Missing value for --artifacts.");
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { artifactsDirectory, dmgPath, help: true, install };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument '${arg}'.`);
    } else if (dmgPath) {
      throw new Error(`Unexpected second DMG path '${arg}'.`);
    } else {
      dmgPath = arg;
    }
  }
  return { artifactsDirectory, dmgPath, help: false, install };
}

function walkDmgs(directory, results) {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) walkDmgs(path, results);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dmg")) {
      const stat = NodeFS.statSync(path);
      results.push({ modifiedAt: stat.mtime, path, size: stat.size });
    }
  }
}

export function discoverDmgs(artifactsDirectory) {
  if (!NodeFS.existsSync(artifactsDirectory)) return [];
  const results = [];
  walkDmgs(artifactsDirectory, results);
  return results.toSorted((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkpointLabel(path) {
  return /nightly\.\d{8}\.(\d+)/.exec(NodePath.basename(path))?.[1] ?? "—";
}

export function renderDmgChoices(dmgs, locale = undefined) {
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return dmgs.map((dmg) => {
    if (dmg.path.includes("\t") || dmg.path.includes("\n")) {
      throw new Error(`Unsupported control character in DMG path: ${dmg.path}`);
    }
    const display = [
      checkpointLabel(dmg.path).padStart(4),
      dateFormatter.format(dmg.modifiedAt),
      formatSize(dmg.size).padStart(8),
      NodePath.basename(dmg.path),
    ].join("  ");
    return `${dmg.path}\t${display}`;
  });
}

export function parseDmgChoice(value) {
  const separator = value.indexOf("\t");
  if (separator <= 0) throw new Error("fzf returned an invalid LastCode DMG selection.");
  return value.slice(0, separator);
}

function selectDmg(dmgs) {
  const fzf = process.env.LASTCODE_FZF_BIN ?? "fzf";
  const result = NodeChildProcess.spawnSync(
    fzf,
    [
      "--height=12",
      "--border",
      "--layout=reverse",
      "--no-sort",
      "--delimiter=\\t",
      "--with-nth=2..",
      "--prompt=Install LastCode > ",
      "--header=Newest build selected · Enter installs · Esc cancels",
    ],
    {
      encoding: "utf8",
      input: `${renderDmgChoices(dmgs).join("\n")}\n`,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("fzf is required. Install it with 'brew install fzf'.");
  }
  if (result.error) throw result.error;
  if (result.status === 130 || result.status === 1) return undefined;
  if (result.status !== 0) throw new Error(`fzf failed with exit code ${result.status}.`);
  return parseDmgChoice(result.stdout.trimEnd());
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.inherit ? "" : result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `${command} failed with exit code ${result.status}.`);
  }
  return options.inherit ? "" : result.stdout.trim();
}

function bundleValue(appPath, key) {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    `Print:${key}`,
    NodePath.join(appPath, "Contents", "Info.plist"),
  ]);
}

function validateApp(appPath) {
  if (!NodeFS.statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The DMG does not contain ${NodePath.basename(appPath)}.`);
  }
  const bundleIdentifier = bundleValue(appPath, "CFBundleIdentifier");
  if (bundleIdentifier !== APP_BUNDLE_ID) {
    throw new Error(`Expected bundle ${APP_BUNDLE_ID}, found ${bundleIdentifier}.`);
  }
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  return bundleValue(appPath, "CFBundleShortVersionString");
}

function appIsRunning() {
  return run("osascript", ["-e", `application id "${APP_BUNDLE_ID}" is running`]) === "true";
}

async function quitApp() {
  if (!appIsRunning()) return;
  console.log("Quitting LastCode…");
  run("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`]);
  const deadline = Date.now() + 30_000;
  while (appIsRunning()) {
    if (Date.now() >= deadline) {
      throw new Error("LastCode did not quit within 30 seconds. Quit it manually and try again.");
    }
    await NodeTimersPromises.setTimeout(250);
  }
}

export function temporaryAppPaths(targetPath, processId = process.pid) {
  const parent = NodePath.dirname(targetPath);
  return {
    backup: NodePath.join(parent, `.LastCode.previous-${processId}.app`),
    staging: NodePath.join(parent, `.LastCode.install-${processId}.app`),
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireInstallLock(lockDirectory, options = {}) {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const lockPath = NodePath.join(lockDirectory, INSTALL_LOCK_NAME);
  const token = `${pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  NodeFS.mkdirSync(lockDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = { schemaVersion: 1, pid, token, startedAt: new Date().toISOString() };
    try {
      // A symlink publishes the complete owner record atomically, so another
      // installer can never observe a lock without its owner metadata.
      NodeFS.symlinkSync(JSON.stringify(owner), lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const currentOwner = JSON.parse(NodeFS.readlinkSync(lockPath));
        if (currentOwner.token !== token) {
          throw new Error(
            "Refusing to release a LastCode install lock now owned by another process.",
          );
        }
        NodeFS.unlinkSync(lockPath);
      };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      let currentOwner;
      try {
        currentOwner = JSON.parse(NodeFS.readlinkSync(lockPath));
      } catch {
        currentOwner = undefined;
      }
      if (Number.isSafeInteger(currentOwner?.pid) && isAlive(currentOwner.pid)) {
        throw new Error(
          `Another LastCode install is already running (PID ${currentOwner.pid}, started ${currentOwner.startedAt ?? "at an unknown time"}).`,
          { cause: error },
        );
      }
      const stalePath = `${lockPath}.stale-${pid}-${Date.now()}`;
      try {
        NodeFS.renameSync(lockPath, stalePath);
      } catch {
        throw new Error(`Another LastCode install acquired ${lockPath}.`);
      }
      NodeFS.rmSync(stalePath, { force: true, recursive: true });
    }
  }
  throw new Error(`Could not acquire the LastCode install lock at ${lockPath}.`);
}

async function installDmg(dmgPath, targetPath = DEFAULT_APP_PATH) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installed script has no Effect runtime.
  if (process.platform !== "darwin") throw new Error("lastcode-install only supports macOS.");
  const resolvedDmg = NodePath.resolve(dmgPath);
  if (!NodeFS.statSync(resolvedDmg, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`DMG not found: ${resolvedDmg}`);
  }

  const releaseInstallLock = acquireInstallLock(
    NodePath.join(NodeOS.homedir(), ".lastcode", "local-updates"),
  );
  try {
    const mountPoint = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-install-"));
    const { backup, staging } = temporaryAppPaths(targetPath);
    let attached = false;
    let oldAppMoved = false;
    try {
      console.log(`Mounting ${NodePath.basename(resolvedDmg)}…`);
      run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, resolvedDmg]);
      attached = true;
      const sourceApp = NodePath.join(mountPoint, "LastCode.app");
      const version = validateApp(sourceApp);

      NodeFS.rmSync(staging, { force: true, recursive: true });
      NodeFS.rmSync(backup, { force: true, recursive: true });
      console.log(`Preparing LastCode ${version}…`);
      run("ditto", [sourceApp, staging]);
      validateApp(staging);
      await quitApp();

      if (NodeFS.existsSync(targetPath)) {
        NodeFS.renameSync(targetPath, backup);
        oldAppMoved = true;
      }
      try {
        NodeFS.renameSync(staging, targetPath);
        run("open", [targetPath]);
      } catch (error) {
        NodeFS.rmSync(targetPath, { force: true, recursive: true });
        if (oldAppMoved) {
          NodeFS.renameSync(backup, targetPath);
          oldAppMoved = false;
        }
        throw error;
      }
      NodeFS.rmSync(backup, { force: true, recursive: true });
      oldAppMoved = false;
      console.log(`Installed and launched LastCode ${version}`);
    } finally {
      NodeFS.rmSync(staging, { force: true, recursive: true });
      if (oldAppMoved && !NodeFS.existsSync(targetPath) && NodeFS.existsSync(backup)) {
        NodeFS.renameSync(backup, targetPath);
      }
      if (attached) {
        try {
          run("hdiutil", ["detach", mountPoint]);
        } catch (error) {
          console.error(`Warning: could not detach ${mountPoint}: ${error.message}`);
        }
      }
      NodeFS.rmSync(mountPoint, { force: true, recursive: true });
    }
  } finally {
    releaseInstallLock();
  }
}

function replaceManagedSymlink(exposed, target) {
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target) {
      throw new Error(`${exposed} already exists and is not managed by LastCode.`);
    }
    NodeFS.unlinkSync(exposed);
  }
  NodeFS.symlinkSync(target, exposed);
}

function installCommand(home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-install.mjs");
  const target = NodePath.join(binDirectory, "lastcode-install");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-install");
  NodeFS.mkdirSync(binDirectory, { recursive: true });
  NodeFS.mkdirSync(exposedDirectory, { recursive: true });
  NodeFS.copyFileSync(NodeURL.fileURLToPath(import.meta.url), moduleTarget);
  NodeFS.writeFileSync(target, renderLauncher(moduleTarget), { encoding: "utf8", mode: 0o755 });
  NodeFS.chmodSync(target, 0o755);
  replaceManagedSymlink(exposed, target);
  console.log(`Installed ${target} with the pinned Node 24 runtime`);
  console.log(`Exposed on PATH as ${exposed}`);
}

async function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log("Usage: lastcode-install [DMG]");
    console.log("       lastcode-install --artifacts PATH");
    console.log("");
    console.log("Without DMG, choose from ~/.lastcode/local-updates/artifacts using fzf.");
    return;
  }
  const home = NodeOS.homedir();
  if (options.install) {
    installCommand(home);
    return;
  }
  const artifactsDirectory = NodePath.resolve(
    options.artifactsDirectory ?? NodePath.join(home, ".lastcode", "local-updates", "artifacts"),
  );
  const dmgs = discoverDmgs(artifactsDirectory);
  if (!options.dmgPath && dmgs.length === 0) {
    throw new Error(`No LastCode DMGs found under ${artifactsDirectory}.`);
  }
  const selected = options.dmgPath ? NodePath.resolve(options.dmgPath) : selectDmg(dmgs);
  if (!selected) {
    console.log("Installation cancelled.");
    return;
  }
  await installDmg(selected);
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`lastcode-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
