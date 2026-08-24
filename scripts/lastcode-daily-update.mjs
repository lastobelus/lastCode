#!/usr/bin/env node

// LastCode-only daily updater for the trusted airy + htulo setup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  cleanupPreparedInstall,
  launchApp,
  prepareDmgInstall,
  quitApp,
  replacePreparedApp,
} from "./lastcode-install.mjs";
import { stageIntelUpdate } from "./lastcode-intel-stage.mjs";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const LABEL = "codes.lastobelus.lastcode-daily-update";
const PAUSE_ACKNOWLEDGEMENT = "PAUSED FOR LASTCODE UPDATE";
const PAUSE_MESSAGE =
  `Pause safely for the prepared LastCode update. Finish your current operation, ` +
  `reply with a line containing exactly '${PAUSE_ACKNOWLEDGEMENT}', then stop this turn.`;
const RESUME_MESSAGE =
  "LastCode has been updated and restarted. Resume from your paused checkpoint.";
const COPIED_MODULES = [
  "lastcode-daily-update.mjs",
  "lastcode-install.mjs",
  "lastcode-intel-release.mjs",
  "lastcode-intel-stage.mjs",
  "lastcode-lock.mjs",
];

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

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseDailyUpdateOptions(argv) {
  const command = argv[0];
  if (!command || !["install", "run", "run-now", "status", "uninstall"].includes(command)) {
    fail("Usage: lastcode:daily-update <install|run|run-now|status|uninstall> [--bootstrap]");
  }
  const bootstrap = argv.slice(1).includes("--bootstrap");
  if (argv.slice(1).some((arg) => arg !== "--bootstrap") || (bootstrap && command !== "run")) {
    fail("--bootstrap is accepted only by the run command.");
  }
  return { bootstrap, command };
}

export function renderDailyUpdatePlist({ logDirectory, modulePath, nodePath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(modulePath)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(NodePath.join(logDirectory, "daily-update.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(NodePath.join(logDirectory, "daily-update.stderr.log"))}</string>
</dict>
</plist>
`;
}

function workingThreads(list) {
  if (list?.kind !== "list" || !Array.isArray(list.threads)) fail("Thread list is invalid.");
  return list.threads.filter((thread) => thread.lifecycle === "working");
}

function hasPauseAcknowledgement(result) {
  return (
    result?.kind === "completed" &&
    result.response.split(/\r?\n/u).some((line) => line.trim() === PAUSE_ACKNOWLEDGEMENT)
  );
}

async function pauseBatch(threads, paused, dependencies) {
  const results = await Promise.allSettled(
    threads.map(async (thread) => {
      const result = await dependencies.sendAndWait(thread.threadId, PAUSE_MESSAGE);
      if (!hasPauseAcknowledgement(result)) {
        fail(`Thread '${thread.title}' did not confirm that it paused.`);
      }
      paused.set(thread.threadId, thread);
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function resumePaused(paused, dependencies) {
  const results = await Promise.allSettled(
    [...paused.values()].map(async (thread) => {
      await dependencies.resumeThread(thread.threadId, RESUME_MESSAGE);
      paused.delete(thread.threadId);
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

export async function runDailyUpdate(options = {}, dependencies) {
  const staged = await dependencies.stageUpdate({ maximumVersionHost: "airy" });
  if (!staged.pending) return { status: "up-to-date" };

  const prepared = await dependencies.prepareInstall(staged.pending.dmgPath, {
    expectedSha256: staged.pending.dmgSha256,
    expectedVersion: staged.pending.version,
  });
  const paused = new Map();
  try {
    if (!options.bootstrap) {
      const first = workingThreads(await dependencies.listThreads());
      await pauseBatch(first, paused, dependencies);

      const newcomers = workingThreads(await dependencies.listThreads()).filter(
        (thread) => !paused.has(thread.threadId),
      );
      await pauseBatch(newcomers, paused, dependencies);
    }

    let updateError;
    try {
      await dependencies.quitApp();
      await dependencies.replaceApp(prepared);
    } catch (error) {
      updateError = error;
    }

    if (updateError) throw updateError;
    return { status: "updated", version: staged.pending.version };
  } finally {
    try {
      if (paused.size > 0) await resumePaused(paused, dependencies);
    } finally {
      dependencies.cleanupInstall(prepared);
    }
  }
}

async function threadCommand(threadTool, args) {
  const { stdout } = await execFile(threadTool, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return parseJson(stdout, `lastcode-thread ${args[0]} output`);
}

async function resumeThread(threadTool, threadId, message) {
  let lastError;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      return await threadCommand(threadTool, ["send", threadId, "--message", message]);
    } catch (error) {
      lastError = error;
      if (attempt < 14) await NodeTimersPromises.setTimeout(2_000);
    }
  }
  throw lastError;
}

function defaultDependencies(home) {
  const threadTool = NodePath.join(home, ".lastcode", "userdata", "bin", "lastcode-thread");
  return {
    cleanupInstall: cleanupPreparedInstall,
    listThreads: () => threadCommand(threadTool, ["list"]),
    prepareInstall: prepareDmgInstall,
    quitApp,
    replaceApp: (prepared) =>
      replacePreparedApp(prepared, {
        launchApp: (appPath) => launchApp(appPath, { maxLaunchAttempts: 1 }),
      }),
    resumeThread: (threadId, message) => resumeThread(threadTool, threadId, message),
    sendAndWait: (threadId, message) =>
      threadCommand(threadTool, [
        "send",
        threadId,
        "--message",
        message,
        "--wait",
        "--timeout",
        "10 minutes",
      ]),
    stageUpdate: (stageOptions) => stageIntelUpdate(stageOptions),
  };
}

function servicePaths(home) {
  const rootDirectory = NodePath.join(home, ".lastcode", "daily-update");
  const moduleDirectory = NodePath.join(rootDirectory, "bin");
  return {
    logDirectory: NodePath.join(rootDirectory, "logs"),
    moduleDirectory,
    modulePath: NodePath.join(moduleDirectory, "lastcode-daily-update.mjs"),
    plistPath: NodePath.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

export function installDailyUpdateService(options = {}) {
  const home = options.home ?? NodeOS.homedir();
  const sourceDirectory =
    options.sourceDirectory ?? NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const nodePath = options.nodePath ?? process.execPath;
  const paths = servicePaths(home);
  NodeFS.mkdirSync(paths.moduleDirectory, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(NodePath.dirname(paths.plistPath), { recursive: true });
  for (const name of COPIED_MODULES) {
    NodeFS.copyFileSync(
      NodePath.join(sourceDirectory, name),
      NodePath.join(paths.moduleDirectory, name),
    );
  }
  NodeFS.writeFileSync(
    paths.plistPath,
    renderDailyUpdatePlist({
      logDirectory: paths.logDirectory,
      modulePath: paths.modulePath,
      nodePath,
    }),
  );
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) fail("Could not determine the current user ID.");
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const runCommand = options.runCommand ?? run;
  runCommand("plutil", ["-lint", paths.plistPath]);
  runCommand("launchctl", ["bootout", service], { allowFailure: true });
  runCommand("launchctl", ["bootstrap", domain, paths.plistPath]);
  return { ...paths, service };
}

async function main(argv) {
  const options = parseDailyUpdateOptions(argv);
  const home = NodeOS.homedir();
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) fail("Could not determine the current user ID.");
  const service = `gui/${uid}/${LABEL}`;
  if (options.command === "run") {
    const result = await runDailyUpdate(options, defaultDependencies(home));
    console.log(JSON.stringify(result));
    return;
  }
  if (options.command === "install") {
    const installed = installDailyUpdateService({ home });
    console.log(`Installed ${installed.service}; it runs daily at 04:00.`);
    return;
  }
  if (options.command === "uninstall") {
    run("launchctl", ["bootout", service], { allowFailure: true });
    const paths = servicePaths(home);
    NodeFS.rmSync(paths.plistPath, { force: true });
    NodeFS.rmSync(paths.moduleDirectory, { force: true, recursive: true });
    return;
  }
  run("launchctl", [options.command === "status" ? "print" : "kickstart", service]);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `[lastcode:daily-update] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
