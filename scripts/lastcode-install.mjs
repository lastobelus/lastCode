#!/usr/bin/env node
// LastCode managed command: lastcode-install

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { LOCK_MODULE_MANAGED_MARKER, acquirePortableLock } from "./lastcode-lock.mjs";

const APP_BUNDLE_ID = "codes.lastobelus.lastcode";
const DEFAULT_APP_PATH = "/Applications/LastCode.app";
const INSTALL_LOCK_NAME = "install.lock";
const INSTALL_MANAGED_MARKER = "LastCode managed command: lastcode-install";
const LAUNCH_POLL_INTERVAL_MS = 250;
const LAUNCH_RETRY_INTERVAL_MS = 2_000;
const LAUNCH_STABILITY_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 30_000;
export const INSTALL_READY_PREFIX = "LASTCODE_INSTALL_READY=";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderLauncher(modulePath) {
  return `#!/bin/sh\n# ${INSTALL_MANAGED_MARKER}\nexec mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
}

export function parseOptions(argv) {
  let artifactsDirectory;
  let dmgPath;
  let install = false;
  let uninstall = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--artifacts") {
      artifactsDirectory = argv[index + 1];
      if (!artifactsDirectory) throw new Error("Missing value for --artifacts.");
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { artifactsDirectory, dmgPath, help: true, install, uninstall };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument '${arg}'.`);
    } else if (dmgPath) {
      throw new Error(`Unexpected second DMG path '${arg}'.`);
    } else {
      dmgPath = arg;
    }
  }
  if (uninstall && (install || artifactsDirectory || dmgPath)) {
    throw new Error("--uninstall cannot be combined with DMG or install options.");
  }
  return { artifactsDirectory, dmgPath, help: false, install, uninstall };
}

export function parseHandoffOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      ![
        "--dmg",
        "--expected-sha256",
        "--expected-version",
        "--parent-pid",
        "--ready-fd",
        "--target",
      ].includes(arg)
    ) {
      throw new Error(`Unknown handoff argument '${arg}'.`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    if (arg === "--dmg") options.dmgPath = NodePath.resolve(value);
    else if (arg === "--expected-sha256") options.expectedSha256 = value;
    else if (arg === "--expected-version") options.expectedVersion = value;
    else if (arg === "--parent-pid") options.parentPid = Number.parseInt(value, 10);
    else if (arg === "--ready-fd") options.readyFd = Number.parseInt(value, 10);
    else options.targetPath = NodePath.resolve(value);
    index += 1;
  }
  if (!options.dmgPath) throw new Error("Missing --dmg.");
  if (!/^[a-f0-9]{64}$/.test(options.expectedSha256 ?? "")) {
    throw new Error("Missing or invalid --expected-sha256.");
  }
  if (!options.expectedVersion) throw new Error("Missing --expected-version.");
  if (!Number.isSafeInteger(options.parentPid) || options.parentPid <= 0) {
    throw new Error("Missing or invalid --parent-pid.");
  }
  if (!Number.isSafeInteger(options.readyFd) || options.readyFd < 3) {
    throw new Error("Missing or invalid --ready-fd.");
  }
  return { ...options, targetPath: options.targetPath ?? DEFAULT_APP_PATH };
}

function walkDmgs(directory, results) {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.includes(".incomplete-")) continue;
      walkDmgs(path, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dmg")) {
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
    ...(options.environment ? { env: options.environment } : {}),
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

export function cleanLaunchEnvironment(environment = process.env) {
  const clean = { ...environment };
  delete clean.ELECTRON_RUN_AS_NODE;
  return clean;
}

export async function launchApp(appPath, options = {}) {
  const isRunning = options.isRunning ?? appIsRunning;
  const now = options.now ?? Date.now;
  const runCommand = options.runCommand ?? run;
  const wait = options.wait ?? NodeTimersPromises.setTimeout;
  const pollIntervalMs = options.pollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS;
  const retryIntervalMs = options.retryIntervalMs ?? LAUNCH_RETRY_INTERVAL_MS;
  const stabilityMs = options.stabilityMs ?? LAUNCH_STABILITY_MS;
  const timeoutMs = options.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const environment = cleanLaunchEnvironment(options.environment ?? process.env);
  let launchAttempts = 0;
  let lastLaunchError;
  let nextLaunchAt = Number.NEGATIVE_INFINITY;
  let runningSince;

  while (true) {
    const currentTime = now();
    if (isRunning()) {
      runningSince ??= currentTime;
      if (currentTime - runningSince >= stabilityMs) {
        console.log(`LastCode remained running after ${launchAttempts} launch attempt(s).`);
        return;
      }
    } else {
      runningSince = undefined;
      if (currentTime >= nextLaunchAt) {
        launchAttempts += 1;
        console.log(`Launching LastCode (attempt ${launchAttempts})…`);
        try {
          runCommand("open", ["-n", "-a", appPath], { environment });
          lastLaunchError = undefined;
        } catch (error) {
          lastLaunchError = error;
        }
        nextLaunchAt = currentTime + retryIntervalMs;
      }
    }

    if (currentTime >= deadline) {
      const detail =
        lastLaunchError instanceof Error ? ` Last launch error: ${lastLaunchError.message}` : "";
      throw new Error(
        `LastCode did not remain running for ${stabilityMs / 1_000} seconds after ${timeoutMs / 1_000} seconds of launch attempts.${detail}`,
      );
    }
    await wait(Math.min(pollIntervalMs, Math.max(0, deadline - currentTime)));
  }
}

export async function quitApp(options = {}) {
  const isRunning = options.isRunning ?? appIsRunning;
  const runCommand = options.runCommand ?? run;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? NodeTimersPromises.setTimeout;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!isRunning()) return;
  console.log("Quitting LastCode…");
  runCommand("osascript", [
    "-e",
    "ignoring application responses",
    "-e",
    `tell application id "${APP_BUNDLE_ID}" to quit`,
    "-e",
    "end ignoring",
  ]);
  const deadline = now() + timeoutMs;
  while (isRunning()) {
    if (now() >= deadline) {
      throw new Error(
        `LastCode did not quit within ${timeoutMs / 1_000} seconds. Quit it manually and try again.`,
      );
    }
    await wait(250);
  }
}

export function temporaryAppPaths(targetPath, processId = process.pid) {
  const parent = NodePath.dirname(targetPath);
  return {
    backup: NodePath.join(parent, `.LastCode.previous-${processId}.app`),
    staging: NodePath.join(parent, `.LastCode.install-${processId}.app`),
  };
}

export function acquireInstallLock(lockDirectory) {
  return acquirePortableLock(lockDirectory, INSTALL_LOCK_NAME, "install");
}

async function hashFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function waitForProcessExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`LastCode process ${pid} did not quit within 30 seconds.`);
    }
    await NodeTimersPromises.setTimeout(100);
  }
}

async function readHandoffCommand(stream = process.stdin) {
  let raw = "";
  for await (const chunk of stream) {
    raw += chunk.toString("utf8");
    const newline = raw.indexOf("\n");
    if (newline >= 0) {
      const command = raw.slice(0, newline).trim();
      if (command === "COMMIT" || command === "CANCEL") return command;
      throw new Error(`Invalid install handoff command '${command}'.`);
    }
    if (raw.length > 32) throw new Error("Install handoff command is too large.");
  }
  throw new Error("Install handoff closed before COMMIT or CANCEL.");
}

async function prepareDmgInstall(dmgPath, options = {}) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installed script has no Effect runtime.
  if (process.platform !== "darwin") throw new Error("lastcode-install only supports macOS.");
  const resolvedDmg = NodePath.resolve(dmgPath);
  if (!NodeFS.statSync(resolvedDmg, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`DMG not found: ${resolvedDmg}`);
  }
  const targetPath = options.targetPath ?? DEFAULT_APP_PATH;
  const releaseInstallLock = acquireInstallLock(
    options.lockDirectory ?? NodePath.join(NodeOS.homedir(), ".lastcode", "local-updates"),
  );
  let prepared;
  try {
    const mountPoint = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-install-"));
    const { backup, staging } = temporaryAppPaths(targetPath);
    prepared = {
      artifactPath: resolvedDmg,
      backup,
      staging,
      targetPath,
      version: undefined,
      attached: false,
      oldAppMoved: false,
      releaseInstallLock,
      released: false,
      mountPoint,
    };
    if (options.expectedSha256) {
      const actualSha256 = await hashFile(resolvedDmg);
      if (actualSha256 !== options.expectedSha256) {
        throw new Error(
          `DMG checksum mismatch: expected ${options.expectedSha256}, found ${actualSha256}.`,
        );
      }
    }
    console.log(`Mounting ${NodePath.basename(resolvedDmg)}…`);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, resolvedDmg]);
    prepared.attached = true;
    const sourceApp = NodePath.join(mountPoint, "LastCode.app");
    const version = validateApp(sourceApp);
    if (options.expectedVersion && version !== options.expectedVersion) {
      throw new Error(`Expected LastCode ${options.expectedVersion}, found ${version} in the DMG.`);
    }
    prepared.version = version;

    NodeFS.rmSync(staging, { force: true, recursive: true });
    NodeFS.rmSync(backup, { force: true, recursive: true });
    console.log(`Preparing LastCode ${version}…`);
    run("ditto", [sourceApp, staging]);
    const stagedVersion = validateApp(staging);
    if (stagedVersion !== version) {
      throw new Error(`Staged LastCode version changed from ${version} to ${stagedVersion}.`);
    }
    run("hdiutil", ["detach", mountPoint]);
    prepared.attached = false;
    NodeFS.rmSync(mountPoint, { force: true, recursive: true });
    return prepared;
  } catch (error) {
    if (prepared) cleanupPreparedInstall(prepared);
    else releaseInstallLock();
    throw error;
  }
}

export async function replacePreparedApp(prepared, options = {}) {
  const launch = options.launchApp ?? ((appPath) => launchApp(appPath, options));
  if (NodeFS.existsSync(prepared.targetPath)) {
    NodeFS.renameSync(prepared.targetPath, prepared.backup);
    prepared.oldAppMoved = true;
  }
  try {
    NodeFS.renameSync(prepared.staging, prepared.targetPath);
    await launch(prepared.targetPath);
  } catch (error) {
    NodeFS.rmSync(prepared.targetPath, { force: true, recursive: true });
    if (prepared.oldAppMoved) {
      NodeFS.renameSync(prepared.backup, prepared.targetPath);
      prepared.oldAppMoved = false;
      try {
        await launch(prepared.targetPath);
      } catch (relaunchError) {
        console.error(
          `Warning: restored the previous LastCode app but could not relaunch it: ${relaunchError.message}`,
        );
      }
    }
    throw error;
  }
  NodeFS.rmSync(prepared.backup, { force: true, recursive: true });
  prepared.oldAppMoved = false;
}

function cleanupPreparedInstall(prepared) {
  NodeFS.rmSync(prepared.staging, { force: true, recursive: true });
  if (
    prepared.oldAppMoved &&
    !NodeFS.existsSync(prepared.targetPath) &&
    NodeFS.existsSync(prepared.backup)
  ) {
    NodeFS.renameSync(prepared.backup, prepared.targetPath);
    prepared.oldAppMoved = false;
  }
  if (prepared.attached) {
    try {
      run("hdiutil", ["detach", prepared.mountPoint]);
    } catch (error) {
      console.error(`Warning: could not detach ${prepared.mountPoint}: ${error.message}`);
    }
  }
  NodeFS.rmSync(prepared.mountPoint, { force: true, recursive: true });
  if (!prepared.released) {
    prepared.releaseInstallLock();
    prepared.released = true;
  }
}

async function installDmg(dmgPath, targetPath = DEFAULT_APP_PATH) {
  const prepared = await prepareDmgInstall(dmgPath, { targetPath });
  try {
    await quitApp();
    await replacePreparedApp(prepared);
    console.log(`Installed and launched LastCode ${prepared.version}`);
  } finally {
    cleanupPreparedInstall(prepared);
  }
}

async function handoffInstall(options) {
  const prepared = await prepareDmgInstall(options.dmgPath, options);
  try {
    NodeFS.writeSync(
      options.readyFd,
      `${INSTALL_READY_PREFIX}${JSON.stringify({
        schemaVersion: 1,
        artifactPath: prepared.artifactPath,
        version: prepared.version,
      })}\n`,
    );
    NodeFS.closeSync(options.readyFd);
    const command = await readHandoffCommand();
    if (command === "CANCEL") return;
    await waitForProcessExit(options.parentPid);
    await replacePreparedApp(prepared);
    console.log(`Installed and launched LastCode ${prepared.version}`);
  } finally {
    cleanupPreparedInstall(prepared);
  }
}

function replaceManagedSymlink(exposed, target) {
  assertManagedSymlink(exposed, target);
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing) {
    NodeFS.unlinkSync(exposed);
  }
  NodeFS.symlinkSync(target, exposed);
}

function assertManagedSymlink(exposed, target) {
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing && (!existing.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target)) {
    throw new Error(`${exposed} already exists and is not managed by LastCode.`);
  }
}

function assertManagedInstallerFile(path) {
  const existing = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (
    existing &&
    (!existing.isFile() || !NodeFS.readFileSync(path, "utf8").includes(INSTALL_MANAGED_MARKER))
  ) {
    throw new Error(`Refusing to modify ${path} because it is not a LastCode-managed file.`);
  }
}

function assertManagedLockModule(path) {
  const existing = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (
    existing &&
    (!existing.isFile() || !NodeFS.readFileSync(path, "utf8").includes(LOCK_MODULE_MANAGED_MARKER))
  ) {
    throw new Error(`Refusing to modify ${path} because it is not a LastCode-managed file.`);
  }
}

export function installCommand(home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const lockModuleTarget = NodePath.join(binDirectory, "lastcode-lock.mjs");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-install.mjs");
  const target = NodePath.join(binDirectory, "lastcode-install");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-install");

  assertManagedLockModule(lockModuleTarget);
  assertManagedInstallerFile(moduleTarget);
  assertManagedInstallerFile(target);
  assertManagedSymlink(exposed, target);

  NodeFS.mkdirSync(binDirectory, { recursive: true });
  NodeFS.mkdirSync(exposedDirectory, { recursive: true });
  NodeFS.copyFileSync(new NodeURL.URL("./lastcode-lock.mjs", import.meta.url), lockModuleTarget);
  NodeFS.copyFileSync(NodeURL.fileURLToPath(import.meta.url), moduleTarget);
  NodeFS.writeFileSync(target, renderLauncher(moduleTarget), { encoding: "utf8", mode: 0o755 });
  NodeFS.chmodSync(target, 0o755);
  replaceManagedSymlink(exposed, target);
  console.log(`Installed ${target} with the pinned Node 24 runtime`);
  console.log(`Exposed on PATH as ${exposed}`);
}

export function uninstallCommand(home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const lockModuleTarget = NodePath.join(binDirectory, "lastcode-lock.mjs");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-install.mjs");
  const target = NodePath.join(binDirectory, "lastcode-install");
  const exposed = NodePath.join(home, ".local", "bin", "lastcode-install");
  const exposedEntry = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (exposedEntry && (!exposedEntry.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target)) {
    throw new Error(`Refusing to remove ${exposed} because it is not managed by LastCode.`);
  }
  assertManagedLockModule(lockModuleTarget);
  for (const path of [moduleTarget, target]) assertManagedInstallerFile(path);

  if (exposedEntry) NodeFS.unlinkSync(exposed);
  for (const path of [lockModuleTarget, moduleTarget, target]) NodeFS.rmSync(path, { force: true });
  try {
    NodeFS.rmdirSync(binDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
  console.log("Uninstalled lastcode-install");
}

async function main(argv) {
  if (argv[0] === "handoff") {
    await handoffInstall(parseHandoffOptions(argv.slice(1)));
    return;
  }
  const options = parseOptions(argv);
  if (options.help) {
    console.log("Usage: lastcode-install [DMG]");
    console.log("       lastcode-install --artifacts PATH");
    console.log("       lastcode-install --uninstall");
    console.log("");
    console.log("Without DMG, choose from ~/.lastcode/local-updates/artifacts using fzf.");
    return;
  }
  const home = NodeOS.homedir();
  if (options.uninstall) {
    uninstallCommand(home);
    return;
  }
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
