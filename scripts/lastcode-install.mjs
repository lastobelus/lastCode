#!/usr/bin/env node
// LastCode managed command: lastcode-install

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
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
const PARENT_QUIT_GRACE_MS = 30_000;
const PARENT_TERM_GRACE_MS = 15_000;
const PARENT_KILL_WAIT_MS = 5_000;
const PARENT_UNSIGNALLED_WAIT_MS = 10 * 60_000;
const HANDOFF_COMMAND_TIMEOUT_MS = 10 * 60_000;
const PARENT_ABANDON_WAIT_MS = 24 * 60 * 60_000;
const TCC_RESET_TIMEOUT_MS = 10_000;
export const INSTALL_READY_PREFIX = "LASTCODE_INSTALL_READY=";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderLauncher(modulePath) {
  return `#!/bin/sh\n# ${INSTALL_MANAGED_MARKER}\nexec env MISE_ACTIVATE_AGGRESSIVE=1 mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
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
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowedExitCodes?.includes(result.status)) {
    const detail = options.inherit ? "" : result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `${command} failed with exit code ${result.status}.`);
  }
  if (
    options.rejectStderr &&
    result.stderr.trim() &&
    !options.allowedStderr?.(result.stderr.trim())
  ) {
    throw new Error(result.stderr.trim());
  }
  if (options.inherit) return "";
  return (options.output === "stderr" ? result.stderr : result.stdout).trim();
}

function bundleValue(appPath, key, runCommand = run) {
  return runCommand("/usr/libexec/PlistBuddy", [
    "-c",
    `Print:${key}`,
    NodePath.join(appPath, "Contents", "Info.plist"),
  ]);
}

export function validateAppBundle(appPath, options = {}) {
  const runCommand = options.runCommand ?? run;
  if (!NodeFS.statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The DMG does not contain ${NodePath.basename(appPath)}.`);
  }
  const bundleIdentifier = bundleValue(appPath, "CFBundleIdentifier", runCommand);
  if (bundleIdentifier !== APP_BUNDLE_ID) {
    throw new Error(`Expected bundle ${APP_BUNDLE_ID}, found ${bundleIdentifier}.`);
  }
  const version = bundleValue(appPath, "CFBundleShortVersionString", runCommand);
  if (options.expectedVersion && version !== options.expectedVersion) {
    throw new Error(`Expected LastCode ${options.expectedVersion}, found ${version} in the DMG.`);
  }
  runCommand("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (options.signaturePolicy === "adhoc") {
    const signature = runCommand("codesign", ["-d", "--verbose=4", appPath], {
      output: "stderr",
    });
    if (!/^Signature=adhoc$/mu.test(signature) || !/^TeamIdentifier=not set$/mu.test(signature)) {
      throw new Error("Expected a certificate-free ad-hoc LastCode signature.");
    }
  }
  if (options.expectedArchitecture) {
    const executable = bundleValue(appPath, "CFBundleExecutable", runCommand);
    const architectures = runCommand("lipo", [
      "-archs",
      NodePath.join(appPath, "Contents", "MacOS", executable),
    ]);
    if (architectures !== options.expectedArchitecture) {
      throw new Error(
        `Expected ${options.expectedArchitecture} LastCode executable, found ${architectures}.`,
      );
    }
  }
  return version;
}

export function shouldResetScreenRecordingPermission(currentApp, replacementApp, options = {}) {
  if (!NodeFS.statSync(currentApp, { throwIfNoEntry: false })?.isDirectory()) return false;
  const runCommand = options.runCommand ?? run;
  const requirement = (appPath) => {
    const output = runCommand("codesign", ["-d", "-r-", appPath]);
    return /^\s*#?\s*designated =>\s*(.+)$/mu.exec(output)?.[1];
  };
  try {
    const current = requirement(currentApp);
    const replacement = requirement(replacementApp);
    return !current || !replacement || current !== replacement;
  } catch {
    // An unreadable existing signature cannot prove that its TCC grant still applies.
    return true;
  }
}

export function resetScreenRecordingPermission(runCommand = run) {
  runCommand("tccutil", ["reset", "ScreenCapture", APP_BUNDLE_ID], {
    timeoutMs: TCC_RESET_TIMEOUT_MS,
  });
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
  const maxLaunchAttempts = options.maxLaunchAttempts ?? Number.POSITIVE_INFINITY;
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
      if (currentTime >= nextLaunchAt && launchAttempts < maxLaunchAttempts) {
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

/**
 * Installs hold the install lock from preparation through the swap, so another process's temporary
 * bundles are leftovers from an install that died mid-swap. Restores a missing app from the newest
 * backup, then removes the rest.
 */
export function recoverInterruptedSwap(targetPath) {
  const parent = NodePath.dirname(targetPath);
  const leftovers = NodeFS.readdirSync(parent)
    .filter((name) => /^\.LastCode\.(?:previous|install)-\d+\.app$/.test(name))
    .map((name) => NodePath.join(parent, name));
  const newestBackup = leftovers
    .filter((path) => NodePath.basename(path).startsWith(".LastCode.previous-"))
    .toSorted((left, right) => NodeFS.statSync(right).mtimeMs - NodeFS.statSync(left).mtimeMs)[0];
  if (newestBackup !== undefined && !NodeFS.existsSync(targetPath)) {
    NodeFS.renameSync(newestBackup, targetPath);
    console.log(`Restored ${targetPath} left aside by an interrupted install.`);
  }
  for (const path of leftovers) NodeFS.rmSync(path, { force: true, recursive: true });
}

export function acquireInstallLock(lockDirectory) {
  return acquirePortableLock(lockDirectory, INSTALL_LOCK_NAME, "install");
}

export async function hashFile(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validateDmgArtifact(dmgPath, options = {}) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installed script has no Effect runtime.
  if (process.platform !== "darwin" && options.allowNonDarwin !== true) {
    throw new Error("LastCode DMG validation only supports macOS.");
  }
  const resolvedDmg = NodePath.resolve(dmgPath);
  if (!NodeFS.statSync(resolvedDmg, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`DMG not found: ${resolvedDmg}`);
  }
  const actualSha256 = await hashFile(resolvedDmg);
  if (options.expectedSha256 && actualSha256 !== options.expectedSha256) {
    throw new Error(
      `DMG checksum mismatch: expected ${options.expectedSha256}, found ${actualSha256}.`,
    );
  }
  const runCommand = options.runCommand ?? run;
  const mountPoint = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-validate-"));
  let attached = false;
  let result;
  let validationError;
  try {
    runCommand("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      resolvedDmg,
    ]);
    attached = true;
    const appPath = NodePath.join(mountPoint, "LastCode.app");
    const version = validateAppBundle(appPath, {
      expectedArchitecture: options.expectedArchitecture,
      expectedVersion: options.expectedVersion,
      runCommand,
      signaturePolicy: options.signaturePolicy,
    });
    result = { appPath: "LastCode.app", sha256: actualSha256, version };
  } catch (error) {
    validationError = error;
  }
  let cleanupError;
  if (attached) {
    try {
      runCommand("hdiutil", ["detach", mountPoint]);
    } catch (error) {
      try {
        runCommand("hdiutil", ["detach", "-force", mountPoint]);
      } catch {
        cleanupError = error;
      }
    }
  }
  try {
    NodeFS.rmSync(mountPoint, { force: true, recursive: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (validationError) throw validationError;
  if (cleanupError) throw cleanupError;
  return result;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: another user's process now holds the PID, so the parent has exited.
    if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
    throw error;
  }
}

// Start time plus argv[0] (the executable path LaunchServices passes) identifies one process.
function processIdentity(pid) {
  const result = NodeChildProcess.spawnSync(
    "/bin/ps",
    ["-o", "lstart=", "-o", "comm=", "-p", String(pid)],
    { encoding: "utf8", timeout: 10_000 },
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

// Before COMMIT the desktop stopped its backends and began quitting, so a stalled
// quit is already waiting on shutdown and exits on SIGTERM
// (DesktopLifecycle.exitIfShutdownStalled). SIGKILL covers a quit that ignores it.
// The monotonic clock keeps each grace period intact across sleep.
export async function waitForParentExit(pid, identity, options = {}) {
  const isAlive = options.isAlive ?? processIsAlive;
  const identityOf = options.processIdentity ?? processIdentity;
  const sendSignal = options.signal ?? ((target, signal) => process.kill(target, signal));
  const now = options.now ?? (() => NodePerfHooks.performance.now());
  const wait = options.wait ?? NodeTimersPromises.setTimeout;
  const executable = ` ${NodePath.resolve(options.targetPath ?? DEFAULT_APP_PATH)}/Contents/MacOS/`;
  // A committed parent that cannot be signalled still quits on its own; give it longer.
  const steps = identity.includes(executable)
    ? [
        { afterMs: PARENT_QUIT_GRACE_MS, signal: "SIGTERM" },
        { afterMs: PARENT_TERM_GRACE_MS, signal: "SIGKILL" },
        { afterMs: PARENT_KILL_WAIT_MS, signal: null },
      ]
    : [{ afterMs: PARENT_UNSIGNALLED_WAIT_MS, signal: null }];
  const startedAt = now();
  let stepStartedAt = startedAt;
  while (isAlive(pid)) {
    const step = steps[0];
    const elapsed = now() - stepStartedAt;
    if (elapsed < step.afterMs) {
      await wait(Math.min(100, step.afterMs - elapsed));
      continue;
    }
    const current = identity ? identityOf(pid) : "";
    // A different process now holds the PID, so the parent has exited.
    if (current !== "" && current !== identity) return;
    if (step.signal === null) {
      if (!isAlive(pid)) return;
      throw new Error(
        `LastCode process ${pid} did not quit within ${Math.round((now() - startedAt) / 1_000)} seconds.`,
      );
    }
    if (current === identity) {
      console.log(
        `LastCode process ${pid} is still quitting after ${Math.round((now() - startedAt) / 1_000)} seconds; sending ${step.signal}.`,
      );
      try {
        sendSignal(pid, step.signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    steps.shift();
    stepStartedAt = now();
  }
}

// A desktop that wedged after READY must not hold the install lock forever.
export async function readHandoffCommand(
  stream = process.stdin,
  timeoutMs = HANDOFF_COMMAND_TIMEOUT_MS,
) {
  const timer = setTimeout(() => {
    stream.destroy(
      new Error(`Install handoff got no COMMIT or CANCEL within ${timeoutMs / 1_000} seconds.`),
    );
  }, timeoutMs);
  try {
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
  } finally {
    clearTimeout(timer);
  }
}

function unrelatedApfsMountWarnings(stderr, bundlePaths, bundleDevice) {
  const lines = stderr.split("\n");
  for (let index = 0; index < lines.length; index += 3) {
    const mount = /^lsof: WARNING: can't stat\(\) apfs file system (\/[^\\\r\n]*)$/u.exec(
      lines[index],
    )?.[1];
    const device = /^      assuming "dev=([a-f\d]+)" from mount table$/u.exec(
      lines[index + 2] ?? "",
    )?.[1];
    if (
      !mount ||
      lines[index + 1] !== "      Output information may be incomplete." ||
      !device ||
      Number.parseInt(device, 16) === bundleDevice
    ) {
      return false;
    }
    const mountPath = NodePath.resolve(mount).toLowerCase();
    if (
      bundlePaths.some((path) => {
        const bundlePath = path.toLowerCase();
        return (
          bundlePath === mountPath ||
          bundlePath.startsWith(mountPath.endsWith("/") ? mountPath : `${mountPath}/`) ||
          mountPath.startsWith(`${bundlePath}/`)
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

// Check path references as well as open bundle files: a bundled server may run
// without a GUI, and a desktop/helper can open resources after startup.
export function appBundleIsInUse(targetPath, options = {}) {
  const runCommand = options.runCommand ?? run;
  const resolved = NodePath.resolve(targetPath);
  const paths = [resolved];
  if (NodeFS.existsSync(resolved)) paths.push(NodeFS.realpathSync(resolved));
  const processes = runCommand("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    rejectStderr: true,
    timeoutMs: 10_000,
  });
  if (!processes.trim()) throw new Error("Could not inspect running processes for bundle use.");
  for (const line of processes.split("\n")) {
    if (!/^\s*\d+\s+\S/u.test(line)) throw new Error("Invalid process inspection output.");
    if (paths.some((path) => line.includes(`${path}/`) || line.trimEnd().endsWith(path))) {
      return true;
    }
  }
  if (!NodeFS.existsSync(resolved)) return false;
  const bundleDevice = NodeFS.statSync(resolved).dev;
  const files = runCommand("/usr/sbin/lsof", ["-nP", "-Fpn", "+D", resolved], {
    allowedExitCodes: [1],
    rejectStderr: true,
    // Darwin scans every mount; an unrelated mount's stat failure does not affect +D's file identities.
    allowedStderr: (stderr) => unrelatedApfsMountWarnings(stderr, paths, bundleDevice),
    timeoutMs: 30_000,
  });
  if (files && !/^p\d+$/mu.test(files)) throw new Error("Invalid bundle file inspection output.");
  return Boolean(files);
}

// Never stop a running app or server. A busy bundle stays installed until a
// later attempt; the final inspection narrows (but cannot eliminate) launch races.
export async function installDmgIfIdle(dmgPath, options = {}) {
  const targetPath = options.targetPath ?? DEFAULT_APP_PATH;
  if (appBundleIsInUse(targetPath, options)) {
    return { status: "deferred", reason: "bundle-in-use" };
  }
  const prepared = await prepareDmgInstall(dmgPath, options);
  try {
    const replaced = await replacePreparedApp(prepared, {
      ...options,
      launch: false,
      idleOnly: true,
    });
    if (!replaced) return { status: "deferred", reason: "bundle-in-use" };
    return { status: "installed", version: prepared.version };
  } finally {
    cleanupPreparedInstall(prepared, options);
  }
}

export async function prepareDmgInstall(dmgPath, options = {}) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installed script has no Effect runtime.
  if (process.platform !== "darwin" && options.allowNonDarwin !== true) {
    throw new Error("lastcode-install only supports macOS.");
  }
  const runCommand = options.runCommand ?? run;
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
    recoverInterruptedSwap(targetPath);
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
    runCommand("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      resolvedDmg,
    ]);
    prepared.attached = true;
    const sourceApp = NodePath.join(mountPoint, "LastCode.app");
    const version = validateAppBundle(sourceApp, { ...options, runCommand });
    if (options.expectedVersion && version !== options.expectedVersion) {
      throw new Error(`Expected LastCode ${options.expectedVersion}, found ${version} in the DMG.`);
    }
    prepared.version = version;

    NodeFS.rmSync(staging, { force: true, recursive: true });
    NodeFS.rmSync(backup, { force: true, recursive: true });
    console.log(`Preparing LastCode ${version}…`);
    runCommand("ditto", [sourceApp, staging]);
    const stagedVersion = validateAppBundle(staging, { ...options, runCommand });
    if (stagedVersion !== version) {
      throw new Error(`Staged LastCode version changed from ${version} to ${stagedVersion}.`);
    }
    runCommand("hdiutil", ["detach", mountPoint]);
    prepared.attached = false;
    NodeFS.rmSync(mountPoint, { force: true, recursive: true });
    return prepared;
  } catch (error) {
    if (prepared) cleanupPreparedInstall(prepared, options);
    else releaseInstallLock();
    throw error;
  }
}

export async function replacePreparedApp(prepared, options = {}) {
  const launch =
    options.launch === false
      ? undefined
      : (options.launchApp ?? ((appPath) => launchApp(appPath, options)));
  let replacementMoved = false;
  const needsPermissionReset =
    (prepared.targetPath === DEFAULT_APP_PATH || options.resetScreenRecordingPermission) &&
    shouldResetScreenRecordingPermission(prepared.targetPath, prepared.staging, options);
  const marker = NodePath.join(
    options.reminderHome ?? NodeOS.homedir(),
    ".lastcode",
    "local-updates",
    "screen-recording-reset",
  );
  const previousMarker =
    needsPermissionReset && NodeFS.existsSync(marker) ? NodeFS.readFileSync(marker) : null;
  // The caller can hold its eligibility lock through inspection, swap, and rollback.
  const releaseEligibility = await options.beforeReplace?.(prepared);
  try {
    if (options.idleOnly && appBundleIsInUse(prepared.targetPath, options)) return false;
    if (needsPermissionReset) {
      NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
      NodeFS.writeFileSync(marker, "pending\n", { mode: 0o600 });
    }
    try {
      if (NodeFS.existsSync(prepared.targetPath)) {
        NodeFS.renameSync(prepared.targetPath, prepared.backup);
        prepared.oldAppMoved = true;
      }
      NodeFS.renameSync(prepared.staging, prepared.targetPath);
      replacementMoved = true;
      await launch?.(prepared.targetPath);
    } catch (error) {
      if (needsPermissionReset) {
        if (previousMarker) NodeFS.writeFileSync(marker, previousMarker);
        else NodeFS.rmSync(marker, { force: true });
      }
      if (replacementMoved) NodeFS.rmSync(prepared.targetPath, { force: true, recursive: true });
      if (prepared.oldAppMoved) {
        NodeFS.renameSync(prepared.backup, prepared.targetPath);
        prepared.oldAppMoved = false;
        try {
          await launch?.(prepared.targetPath);
        } catch (relaunchError) {
          console.error(
            `Warning: restored the previous LastCode app but could not relaunch it: ${relaunchError.message}`,
          );
        }
      }
      throw error;
    }
    if (needsPermissionReset) {
      try {
        (options.resetScreenRecordingPermission ?? resetScreenRecordingPermission)();
        console.log("LastCode Screen Recording permission was reset for the replacement app.");
      } catch (error) {
        console.error(
          `Warning: could not reset LastCode Screen Recording permission: ${error.message}. Remove any existing LastCode entry in System Settings before adding this build.`,
        );
      }
      NodeFS.writeFileSync(marker, "ready\n", { mode: 0o600 });
    }
    NodeFS.rmSync(prepared.backup, { force: true, recursive: true });
    prepared.oldAppMoved = false;
    return true;
  } finally {
    releaseEligibility?.();
  }
}

export function cleanupPreparedInstall(prepared, options = {}) {
  const runCommand = options.runCommand ?? run;
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
      runCommand("hdiutil", ["detach", prepared.mountPoint]);
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

// After COMMIT the parent is quitting for good, so a failed install must still
// leave an app running: the old bundle stays at the target unless the swap ran.
// Waits without signalling for a parent the helper could not stop; true once it has exited.
async function waitUntilProcessGone(pid) {
  const deadline = NodePerfHooks.performance.now() + PARENT_ABANDON_WAIT_MS;
  while (processIsAlive(pid)) {
    if (NodePerfHooks.performance.now() >= deadline) return false;
    await NodeTimersPromises.setTimeout(1_000);
  }
  return true;
}

export async function finishCommittedInstall(prepared, parent, options = {}) {
  const waitForParent = options.waitForParentExit ?? waitForParentExit;
  const replace = options.replacePreparedApp ?? replacePreparedApp;
  const isRunning = options.isRunning ?? appIsRunning;
  const launch = options.launchApp ?? ((appPath) => launchApp(appPath));
  const waitUntilParentGone = options.waitUntilParentGone ?? waitUntilProcessGone;
  // Only an original bundle that was already at the target is safe to relaunch.
  const originalAtTarget = NodeFS.existsSync(prepared.targetPath);
  let parentGone = false;
  try {
    console.log(`Waiting for LastCode process ${parent.pid} to quit…`);
    await waitForParent(parent.pid, parent.identity, { targetPath: prepared.targetPath });
    parentGone = true;
    await replace(prepared);
    console.log(`Installed and launched LastCode ${prepared.version}`);
  } catch (error) {
    console.error(`LastCode ${prepared.version} was not installed: ${error.message}`);
    // A parent still quitting would look like a running app; relaunch after it has gone.
    if (!parentGone && !(await waitUntilParentGone(parent.pid))) throw error;
    // Relaunch only the original bundle: restore it if a failed rollback left it aside.
    if (
      prepared.oldAppMoved &&
      !NodeFS.existsSync(prepared.targetPath) &&
      NodeFS.existsSync(prepared.backup)
    ) {
      try {
        NodeFS.renameSync(prepared.backup, prepared.targetPath);
        prepared.oldAppMoved = false;
      } catch (restoreError) {
        console.error(`Warning: could not restore the previous LastCode: ${restoreError.message}`);
      }
    }
    if (
      originalAtTarget &&
      !prepared.oldAppMoved &&
      NodeFS.existsSync(prepared.targetPath) &&
      !isRunning()
    ) {
      try {
        await launch(prepared.targetPath);
      } catch (relaunchError) {
        console.error(`Warning: could not relaunch LastCode: ${relaunchError.message}`);
      }
    }
    throw error;
  }
}

async function handoffInstall(options) {
  // Captured while the parent is certainly alive: it spawned this helper and holds its pipes.
  const parentIdentity =
    process.ppid === options.parentPid ? processIdentity(options.parentPid) : "";
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
    await finishCommittedInstall(prepared, {
      pid: options.parentPid,
      identity: parentIdentity,
    });
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
  const buildModuleTarget = NodePath.join(binDirectory, "lastcode-build.mjs");
  const updateHelperTarget = NodePath.join(binDirectory, "lastcode-local-update.mjs");
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
  for (const path of [moduleTarget, target]) NodeFS.rmSync(path, { force: true });
  if (!NodeFS.existsSync(buildModuleTarget) && !NodeFS.existsSync(updateHelperTarget)) {
    NodeFS.rmSync(lockModuleTarget, { force: true });
  }
  try {
    NodeFS.rmdirSync(binDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
  console.log("Uninstalled lastcode-install");
}

async function main(argv) {
  if (argv[0] === "handoff") {
    // install.log accumulates every run; timestamps make one attempt readable.
    for (const method of ["log", "error"]) {
      const write = console[method].bind(console);
      console[method] = (...args) => write(`[${new Date().toISOString()}]`, ...args);
    }
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
