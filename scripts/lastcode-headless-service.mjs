#!/usr/bin/env node

// LastCode-only packaged server service for the trusted htulo host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

export const HEADLESS_SERVICE_LABEL = "codes.lastobelus.lastcode.server";
export const HEADLESS_SERVICE_PORT = 3773;
const DEFAULT_APP_PATH = "/Applications/LastCode.app";
const START_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(options.environment ? { env: options.environment } : {}),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      result.stderr?.trim() || `${command} ${args.join(" ")} failed with ${result.status}.`,
    );
  }
  return result;
}

function uid() {
  const value = process.getuid?.();
  if (!Number.isSafeInteger(value)) fail("Could not determine the current user ID.");
  return value;
}

export function headlessServicePaths(home = NodeOS.homedir(), appPath = DEFAULT_APP_PATH) {
  return {
    appPath,
    executablePath: NodePath.join(appPath, "Contents", "MacOS", "LastCode"),
    logDirectory: NodePath.join(home, ".lastcode", "userdata", "logs"),
    plistPath: NodePath.join(home, "Library", "LaunchAgents", `${HEADLESS_SERVICE_LABEL}.plist`),
    serverPath: NodePath.join(
      appPath,
      "Contents",
      "Resources",
      "app.asar",
      "apps",
      "server",
      "dist",
      "bin.mjs",
    ),
  };
}

export function renderHeadlessServicePlist({ executablePath, home, logDirectory, serverPath }) {
  const providerPath = [
    NodePath.join(home, ".local", "bin"),
    NodePath.join(home, ".local", "share", "mise", "shims"),
    NodePath.join(home, ".mise", "shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HEADLESS_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executablePath)}</string>
    <string>${xml(serverPath)}</string>
    <string>serve</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>${String(HEADLESS_SERVICE_PORT)}</string>
    <string>--base-dir</string>
    <string>${xml(NodePath.join(home, ".lastcode"))}</string>
    <string>--no-browser</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>PATH</key>
    <string>${xml(providerPath)}</string>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(logDirectory, "headless-server.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(logDirectory, "headless-server.stderr.log"))}</string>
</dict>
</plist>
`;
}

function serviceTarget(options = {}) {
  return `gui/${options.uid ?? uid()}/${HEADLESS_SERVICE_LABEL}`;
}

export function stopHeadlessService(options = {}) {
  const runCommand = options.runCommand ?? run;
  const target = serviceTarget(options);
  runCommand("launchctl", ["bootout", target], { allowFailure: true });
  const remaining = runCommand("launchctl", ["print", target], {
    allowFailure: true,
    capture: true,
  });
  if (remaining.status === 0) {
    fail(`Could not stop ${target}.`);
  }
}

export async function waitForHeadlessService(options = {}) {
  const expectedServerVersion = options.expectedServerVersion;
  if (!expectedServerVersion) fail("Expected packaged server version is required.");
  const fetchDescriptor =
    options.fetchDescriptor ??
    (() => fetch(`http://127.0.0.1:${String(HEADLESS_SERVICE_PORT)}/.well-known/t3/environment`));
  const wait = options.wait ?? NodeTimersPromises.setTimeout;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  let lastError;
  while (now() < deadline) {
    try {
      const response = await fetchDescriptor();
      if (!response.ok) throw new Error(`readiness returned HTTP ${String(response.status)}`);
      const descriptor = await response.json();
      if (descriptor?.serverVersion !== expectedServerVersion) {
        throw new Error(
          `readiness reported server ${String(descriptor?.serverVersion)}, expected ${expectedServerVersion}`,
        );
      }
      if (descriptor?.platform?.os !== "darwin" || descriptor?.platform?.arch !== "x64") {
        throw new Error("readiness did not report the htulo macOS x64 server");
      }
      return descriptor;
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw new Error(
    `LastCode server ${expectedServerVersion} did not become ready on port ${String(HEADLESS_SERVICE_PORT)} within ${(options.timeoutMs ?? START_TIMEOUT_MS) / 1_000} seconds: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function startHeadlessService(options = {}) {
  const home = options.home ?? NodeOS.homedir();
  const paths = headlessServicePaths(home, options.appPath);
  const runCommand = options.runCommand ?? run;
  const readAppVersion = options.readAppVersion ?? readInstalledLastCodeVersion;
  const installedVersion = readAppVersion(options);
  if (installedVersion !== options.expectedVersion) {
    fail(`Installed LastCode is ${installedVersion}, expected ${options.expectedVersion}.`);
  }
  const readServerVersion = options.readServerVersion ?? readPackagedServerVersion;
  const expectedServerVersion = options.expectedServerVersion ?? readServerVersion(options);
  runCommand("launchctl", ["bootstrap", `gui/${options.uid ?? uid()}`, paths.plistPath]);
  return waitForHeadlessService({ ...options, expectedServerVersion });
}

export async function restartHeadlessService(options = {}) {
  stopHeadlessService(options);
  return startHeadlessService(options);
}

export function readInstalledLastCodeVersion(options = {}) {
  const paths = headlessServicePaths(options.home, options.appPath);
  const runCommand = options.runCommand ?? run;
  const result = runCommand(
    "plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      NodePath.join(paths.appPath, "Contents", "Info.plist"),
    ],
    { capture: true },
  );
  return result.stdout.trim();
}

export function readPackagedServerVersion(options = {}) {
  const paths = headlessServicePaths(options.home, options.appPath);
  const runCommand = options.runCommand ?? run;
  const result = runCommand(paths.executablePath, [paths.serverPath, "--version"], {
    capture: true,
    environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const version = /\bv(\S+)\s*$/u.exec(result.stdout)?.[1];
  if (!version) fail(`Could not read the packaged server version from '${result.stdout.trim()}'.`);
  return version;
}

export async function installHeadlessService(options = {}) {
  const home = options.home ?? NodeOS.homedir();
  const paths = headlessServicePaths(home, options.appPath);
  const runCommand = options.runCommand ?? run;
  NodeFS.mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(NodePath.dirname(paths.plistPath), { recursive: true });
  NodeFS.writeFileSync(paths.plistPath, renderHeadlessServicePlist({ ...paths, home }));
  runCommand("plutil", ["-lint", paths.plistPath]);
  if (options.start === false) return { ...paths, service: serviceTarget(options) };
  const expectedVersion = options.expectedVersion ?? readInstalledLastCodeVersion(options);
  await restartHeadlessService({ ...options, expectedVersion });
  return { ...paths, service: serviceTarget(options) };
}

export function parseHeadlessServiceOptions(argv) {
  const command = argv[0];
  if (!command || !["install", "start", "stop", "status", "uninstall"].includes(command)) {
    fail("Usage: lastcode:headless-service <install|start|stop|status|uninstall>");
  }
  if (argv.length !== 1) fail(`Unexpected argument '${argv[1]}'.`);
  return { command };
}

async function main(argv) {
  const { command } = parseHeadlessServiceOptions(argv);
  const home = NodeOS.homedir();
  if (command === "install") {
    const installed = await installHeadlessService({ home });
    console.log(
      `Installed and started ${installed.service} on port ${String(HEADLESS_SERVICE_PORT)}.`,
    );
    return;
  }
  if (command === "stop") {
    stopHeadlessService({ home });
    return;
  }
  if (command === "uninstall") {
    stopHeadlessService({ home });
    NodeFS.rmSync(headlessServicePaths(home).plistPath, { force: true });
    return;
  }
  if (command === "start") {
    const expectedVersion = readInstalledLastCodeVersion({ home });
    await restartHeadlessService({ expectedVersion, home });
    return;
  }
  run("launchctl", ["print", serviceTarget()]);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `[lastcode:headless-service] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
