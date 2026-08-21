import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireInstallLock,
  cleanLaunchEnvironment,
  discoverDmgs,
  installCommand,
  launchApp,
  parseDmgChoice,
  parseHandoffOptions,
  parseOptions,
  quitApp,
  replacePreparedApp,
  renderDmgChoices,
  renderLauncher,
  temporaryAppPaths,
  uninstallCommand,
} from "./lastcode-install.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-install-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- This integration test exercises a macOS-only kernel lock.
const itMacOnly = process.platform === "darwin" ? it : it.skip;

describe("LastCode userland install command", () => {
  it("parses an optional DMG or artifacts directory", () => {
    expect(parseOptions([])).toMatchObject({ dmgPath: undefined, install: false });
    expect(parseOptions(["/tmp/LastCode.dmg"]).dmgPath).toBe("/tmp/LastCode.dmg");
    expect(parseOptions(["--artifacts", "/tmp/builds"]).artifactsDirectory).toBe("/tmp/builds");
    expect(() => parseOptions(["one.dmg", "two.dmg"])).toThrow("Unexpected second DMG");
    expect(parseOptions(["--uninstall"]).uninstall).toBe(true);
    expect(() => parseOptions(["--uninstall", "one.dmg"])).toThrow("cannot be combined");
  });

  it("requires an exact artifact identity for managed handoff", () => {
    expect(
      parseHandoffOptions([
        "--dmg",
        "/tmp/LastCode.dmg",
        "--expected-sha256",
        "a".repeat(64),
        "--expected-version",
        "1.2.3-nightly.1",
        "--parent-pid",
        "42",
        "--ready-fd",
        "3",
      ]),
    ).toMatchObject({
      dmgPath: "/tmp/LastCode.dmg",
      expectedSha256: "a".repeat(64),
      expectedVersion: "1.2.3-nightly.1",
      parentPid: 42,
      readyFd: 3,
      targetPath: "/Applications/LastCode.app",
    });
    expect(() =>
      parseHandoffOptions([
        "--dmg",
        "/tmp/LastCode.dmg",
        "--expected-version",
        "1.2.3",
        "--parent-pid",
        "42",
        "--ready-fd",
        "3",
      ]),
    ).toThrow("expected-sha256");
  });

  it("discovers DMGs recursively with the newest first", () => {
    const root = temporaryDirectory();
    const older = NodePath.join(root, "1095", "old.dmg");
    const newer = NodePath.join(root, "1104", "new.dmg");
    NodeFS.mkdirSync(NodePath.dirname(older), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(newer), { recursive: true });
    NodeFS.writeFileSync(older, "old");
    NodeFS.writeFileSync(newer, "new");
    NodeFS.utimesSync(older, new Date(1_000), new Date(1_000));
    NodeFS.utimesSync(newer, new Date(2_000), new Date(2_000));

    expect(discoverDmgs(root).map((entry) => entry.path)).toEqual([newer, older]);
  });

  it("excludes quarantined incomplete builds from the DMG picker", () => {
    const root = temporaryDirectory();
    const complete = NodePath.join(root, "1104", "complete.dmg");
    const quarantined = NodePath.join(root, "1105.incomplete-123", "quarantined.dmg");
    NodeFS.mkdirSync(NodePath.dirname(complete), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(quarantined), { recursive: true });
    NodeFS.writeFileSync(complete, "complete");
    NodeFS.writeFileSync(quarantined, "incomplete");

    expect(discoverDmgs(root).map((entry) => entry.path)).toEqual([complete]);
  });

  it("keeps the newest DMG first and round-trips its hidden path through fzf", () => {
    const choices = renderDmgChoices(
      [
        {
          modifiedAt: new Date("2026-08-15T22:00:00Z"),
          path: "/tmp/LastCode-0.0.34-nightly.20260815.1104-arm64.dmg",
          size: 150 * 1024 * 1024,
        },
        {
          modifiedAt: new Date("2026-08-14T22:00:00Z"),
          path: "/tmp/LastCode-0.0.34-nightly.20260814.1095-arm64.dmg",
          size: 149 * 1024 * 1024,
        },
      ],
      "en-CA",
    );
    expect(choices[0]).toContain("1104");
    expect(parseDmgChoice(choices[0])).toContain("20260815.1104");
  });

  it("stages and backs up beside the application for safe renames", () => {
    expect(temporaryAppPaths("/Applications/LastCode.app", 42)).toEqual({
      backup: "/Applications/.LastCode.previous-42.app",
      staging: "/Applications/.LastCode.install-42.app",
    });
  });

  it("requests quit without waiting for an AppleEvent response", async () => {
    let checks = 0;
    const commands = [];
    await quitApp({
      isRunning: () => {
        checks += 1;
        return checks < 3;
      },
      now: () => 0,
      runCommand: (command, args) => commands.push([command, args]),
      wait: () => Promise.resolve(),
    });

    expect(commands).toEqual([
      [
        "osascript",
        [
          "-e",
          "ignoring application responses",
          "-e",
          'tell application id "codes.lastobelus.lastcode" to quit',
          "-e",
          "end ignoring",
        ],
      ],
    ]);
    expect(checks).toBe(3);
  });

  it("bounds the wait for an application that does not quit", async () => {
    const times = [0, 30_000];
    await expect(
      quitApp({
        isRunning: () => true,
        now: () => times.shift() ?? 30_000,
        runCommand: () => undefined,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow("did not quit within 30 seconds");
  });

  it("scrubs Electron's Node mode and retries until the app remains running", async () => {
    let elapsed = 0;
    let launches = 0;
    const commands = [];

    await launchApp("/Applications/LastCode.app", {
      environment: { ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "yes" },
      isRunning: () => launches >= 2 && elapsed >= 2_500,
      now: () => elapsed,
      pollIntervalMs: 250,
      retryIntervalMs: 1_000,
      runCommand: (command, args, options) => {
        launches += 1;
        commands.push([command, args, options]);
      },
      stabilityMs: 500,
      timeoutMs: 5_000,
      wait: async (delay) => {
        elapsed += delay;
      },
    });

    expect(launches).toBe(3);
    expect(commands).toEqual([
      ["open", ["-n", "-a", "/Applications/LastCode.app"], { environment: { KEEP_ME: "yes" } }],
      ["open", ["-n", "-a", "/Applications/LastCode.app"], { environment: { KEEP_ME: "yes" } }],
      ["open", ["-n", "-a", "/Applications/LastCode.app"], { environment: { KEEP_ME: "yes" } }],
    ]);
    expect(cleanLaunchEnvironment({ ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "yes" })).toEqual({
      KEEP_ME: "yes",
    });
  });

  it("bounds relaunch attempts when the app never remains running", async () => {
    let elapsed = 0;
    await expect(
      launchApp("/Applications/LastCode.app", {
        isRunning: () => false,
        now: () => elapsed,
        pollIntervalMs: 250,
        retryIntervalMs: 500,
        runCommand: () => undefined,
        stabilityMs: 500,
        timeoutMs: 1_000,
        wait: async (delay) => {
          elapsed += delay;
        },
      }),
    ).rejects.toThrow("did not remain running");
  });

  it("restores the previous app when launch fails after the swap", async () => {
    const root = temporaryDirectory();
    const targetPath = NodePath.join(root, "LastCode.app");
    const staging = NodePath.join(root, ".LastCode.install.app");
    const backup = NodePath.join(root, ".LastCode.previous.app");
    NodeFS.mkdirSync(targetPath);
    NodeFS.writeFileSync(NodePath.join(targetPath, "version"), "old");
    NodeFS.mkdirSync(staging);
    NodeFS.writeFileSync(NodePath.join(staging, "version"), "new");
    const prepared = { targetPath, staging, backup, oldAppMoved: false };

    const launchAttempts = [];
    await expect(
      replacePreparedApp(prepared, {
        launchApp: async (path) => {
          launchAttempts.push(path);
          throw new Error("launch failed");
        },
      }),
    ).rejects.toThrow("launch failed");
    expect(NodeFS.readFileSync(NodePath.join(targetPath, "version"), "utf8")).toBe("old");
    expect(NodeFS.existsSync(backup)).toBe(false);
    expect(launchAttempts).toEqual([targetPath, targetPath]);
  });

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-install.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/lastcode-install.mjs' \"$@\"",
    );
  });

  it("installs the locking companion beside the standalone installer", () => {
    const home = temporaryDirectory();
    installCommand(home);
    const modulePath = NodePath.join(home, ".lastcode", "bin", "lastcode-install.mjs");

    expect(
      NodeFS.readFileSync(NodePath.join(home, ".lastcode", "bin", "lastcode-lock.mjs"), "utf8"),
    ).toContain("LastCode managed companion: lastcode-lock");
    const result = NodeChildProcess.spawnSync(process.execPath, [modulePath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: lastcode-install");
  });

  itMacOnly("serializes installers and releases the kernel lock", () => {
    const root = temporaryDirectory();
    const release = acquireInstallLock(root);
    expect(() => acquireInstallLock(root)).toThrow("already running");
    release();

    const lockPath = NodePath.join(root, "install.lock");
    expect(JSON.parse(NodeFS.readFileSync(lockPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      pid: process.pid,
    });
    const releaseAgain = acquireInstallLock(root);
    releaseAgain();
  });

  it("uninstalls the managed installer and refuses foreign files", () => {
    const home = temporaryDirectory();
    const binDirectory = NodePath.join(home, ".lastcode", "bin");
    const exposedDirectory = NodePath.join(home, ".local", "bin");
    const target = NodePath.join(binDirectory, "lastcode-install");
    const exposed = NodePath.join(exposedDirectory, "lastcode-install");
    NodeFS.mkdirSync(binDirectory, { recursive: true });
    NodeFS.mkdirSync(exposedDirectory, { recursive: true });
    NodeFS.writeFileSync(target, "# LastCode managed command: lastcode-install\n");
    NodeFS.writeFileSync(
      NodePath.join(binDirectory, "lastcode-install.mjs"),
      "// LastCode managed command: lastcode-install\n",
    );
    NodeFS.symlinkSync(target, exposed);

    uninstallCommand(home);
    expect(NodeFS.existsSync(exposed)).toBe(false);
    expect(NodeFS.existsSync(target)).toBe(false);

    NodeFS.writeFileSync(exposed, "mine");
    expect(() => uninstallCommand(home)).toThrow("not managed by LastCode");

    NodeFS.rmSync(exposed);
    NodeFS.mkdirSync(binDirectory, { recursive: true });
    NodeFS.writeFileSync(target, "mine");
    NodeFS.symlinkSync(target, exposed);
    expect(() => uninstallCommand(home)).toThrow("not a LastCode-managed file");
    expect(NodeFS.existsSync(target)).toBe(true);
    expect(NodeFS.existsSync(exposed)).toBe(true);
  });

  it("preflights every installer-command destination before installing", () => {
    for (const relativePath of [
      ".lastcode/bin/lastcode-install.mjs",
      ".lastcode/bin/lastcode-install",
      ".local/bin/lastcode-install",
    ]) {
      const home = temporaryDirectory();
      const foreignPath = NodePath.join(home, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(foreignPath), { recursive: true });
      NodeFS.writeFileSync(foreignPath, "foreign content\n");

      expect(() => installCommand(home)).toThrow(
        /not (?:a LastCode-managed file|managed by LastCode)/,
      );
      expect(NodeFS.readFileSync(foreignPath, "utf8")).toBe("foreign content\n");
      for (const candidate of [
        ".lastcode/bin/lastcode-install.mjs",
        ".lastcode/bin/lastcode-install",
      ]) {
        const candidatePath = NodePath.join(home, candidate);
        if (candidatePath !== foreignPath) expect(NodeFS.existsSync(candidatePath)).toBe(false);
      }
    }
  });
});
