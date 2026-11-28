import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireInstallLock,
  appBundleIsInUse,
  installDmgIfIdle,
  prepareDmgInstall,
  cleanupPreparedInstall,
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
  resetScreenRecordingPermission,
  shouldResetScreenRecordingPermission,
  temporaryAppPaths,
  uninstallCommand,
  validateAppBundle,
  validateDmgArtifact,
  finishCommittedInstall,
  readHandoffCommand,
  waitForParentExit,
} from "./lastcode-install.mjs";
import {
  readDesktopInstallOutcome,
  recordReplacementBackend,
  retainedBundlePath,
} from "./lastcode-install-outcome.mjs";

const temporaryDirectories = [];

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
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
const itMacOnly = it.runIf(process.platform === "darwin");

describe("LastCode userland install command", () => {
  function mountWarning(path, device = "1234") {
    return `lsof: WARNING: can't stat() apfs file system ${path}\n      Output information may be incomplete.\n      assuming "dev=${device}" from mount table\n`;
  }

  function mockFileInspection(result) {
    vi.spyOn(NodeChildProcess.default, "spawnSync").mockImplementation((command) => ({
      pid: 42,
      output: [],
      signal: null,
      status: 0,
      stdout: "1 /sbin/launchd\n",
      stderr: "",
      ...(command === "/usr/sbin/lsof" ? result : {}),
    }));
    NodeModule.syncBuiltinESMExports();
  }

  function idleFixture() {
    const root = temporaryDirectory();
    const targetPath = NodePath.join(root, "LastCode.app");
    const dmgPath = NodePath.join(root, "LastCode.dmg");
    NodeFS.mkdirSync(targetPath);
    NodeFS.writeFileSync(NodePath.join(targetPath, "version"), "old");
    NodeFS.writeFileSync(dmgPath, "fixture dmg");
    const commands = [];
    let processReads = 0;
    const state = { busyOnSecondRead: false, architecture: "x86_64", signature: "adhoc" };
    const runCommand = (command, args) => {
      commands.push(command);
      if (command === "/bin/ps") {
        processReads += 1;
        return state.busyOnSecondRead && processReads === 2
          ? `42 ${targetPath}/Contents/MacOS/LastCode`
          : "1 /sbin/launchd";
      }
      if (command === "/usr/sbin/lsof") return "";
      if (command === "hdiutil") {
        if (args[0] === "attach") NodeFS.mkdirSync(NodePath.join(args[4], "LastCode.app"));
        return "";
      }
      if (command === "ditto") {
        NodeFS.cpSync(args[0], args[1], { recursive: true });
        NodeFS.writeFileSync(NodePath.join(args[1], "version"), "new");
        return "";
      }
      if (command === "/usr/libexec/PlistBuddy") {
        if (args[1] === "Print:CFBundleIdentifier") return "codes.lastobelus.lastcode";
        if (args[1] === "Print:CFBundleShortVersionString") return "1.2.3-nightly.1";
        if (args[1] === "Print:CFBundleExecutable") return "LastCode";
      }
      if (command === "codesign") {
        return args[0] === "-d" ? `Signature=${state.signature}\nTeamIdentifier=not set` : "";
      }
      if (command === "lipo") return state.architecture;
      throw new Error(`Unexpected command ${command}`);
    };
    return {
      targetPath,
      dmgPath,
      commands,
      state,
      options: {
        targetPath,
        lockDirectory: root,
        runCommand,
        allowNonDarwin: true,
        expectedArchitecture: "x86_64",
        signaturePolicy: "adhoc",
        expectedVersion: "1.2.3-nightly.1",
      },
    };
  }

  it.each([
    "/Contents/MacOS/LastCode",
    "/Contents/Frameworks/LastCode Helper.app/Contents/MacOS/LastCode Helper",
    "/Contents/Resources/server.asar/apps/server/dist/bin.mjs",
  ])("detects a running bundle path: %s", (suffix) => {
    const { targetPath } = idleFixture();
    expect(
      appBundleIsInUse(targetPath, {
        runCommand: () => `42 ${targetPath}${suffix}`,
      }),
    ).toBe(true);
  });

  it("detects open bundle files and fails closed on inspection errors", () => {
    const fixture = idleFixture();
    expect(
      appBundleIsInUse(fixture.targetPath, {
        runCommand: (command) => (command === "/bin/ps" ? "1 /sbin/launchd" : "p42\nnfixture file"),
      }),
    ).toBe(true);
    expect(() =>
      appBundleIsInUse(fixture.targetPath, {
        runCommand: () => {
          throw new Error("inspection denied");
        },
      }),
    ).toThrow("inspection denied");
    expect(() => appBundleIsInUse(fixture.targetPath, { runCommand: () => "" })).toThrow(
      "Could not inspect",
    );
  });

  it("accepts unrelated APFS mount warnings without losing open bundle files", () => {
    const fixture = idleFixture();
    const stderr =
      mountWarning("/Volumes/unavailable-volume") + mountWarning("/Volumes/another-volume");
    mockFileInspection({ status: 1, stdout: "", stderr });
    expect(appBundleIsInUse(fixture.targetPath)).toBe(false);

    mockFileInspection({ status: 0, stdout: "p42\nnfixture file\n", stderr });
    expect(appBundleIsInUse(fixture.targetPath)).toBe(true);
  });

  it.each([
    "bundle",
    "ancestor",
    "root",
    "case",
    "descendant",
    "unknown",
    "mixed",
    "incomplete",
    "escaped",
    "same-device",
  ])("rejects %s inspection warnings", (scenario) => {
    const fixture = idleFixture();
    const warnings = {
      bundle: mountWarning(fixture.targetPath),
      ancestor: mountWarning(NodePath.dirname(fixture.targetPath)),
      root: mountWarning("/"),
      case: mountWarning(fixture.targetPath.toUpperCase()),
      descendant: mountWarning(NodePath.join(fixture.targetPath, "Contents")),
      unknown: "lsof: inspection denied\n",
      mixed: `${mountWarning("/Volumes/unavailable-volume")}lsof: inspection denied\n`,
      incomplete: "      Output information may be incomplete.\n",
      escaped: mountWarning("/Volumes/unavailable\\040volume"),
      "same-device": mountWarning(
        "/Volumes/unavailable-volume",
        NodeFS.statSync(fixture.targetPath).dev.toString(16),
      ),
    };
    mockFileInspection({ status: 1, stdout: "", stderr: warnings[scenario] });
    expect(() => appBundleIsInUse(fixture.targetPath)).toThrow();
  });

  it("rejects failed lsof commands even with an unrelated APFS warning", () => {
    const fixture = idleFixture();
    mockFileInspection({
      status: 2,
      stdout: "",
      stderr: mountWarning("/Volumes/unavailable-volume"),
    });
    expect(() => appBundleIsInUse(fixture.targetPath)).toThrow();
  });

  it("rejects warnings about the canonical bundle behind a symlink", () => {
    const fixture = idleFixture();
    const alias = NodePath.join(NodePath.dirname(fixture.targetPath), "alias.app");
    NodeFS.symlinkSync(fixture.targetPath, alias);
    mockFileInspection({
      status: 1,
      stdout: "",
      stderr: mountWarning(NodeFS.realpathSync(fixture.targetPath)),
    });
    expect(() => appBundleIsInUse(alias)).toThrow();
  });

  it("does not reinspect an unrelated inaccessible mount", () => {
    const fixture = idleFixture();
    const mount = "/Volumes/unavailable-volume";
    const nativeExists = NodeFS.existsSync;
    const nativeRealpath = NodeFS.realpathSync;
    vi.spyOn(NodeFS.default, "existsSync").mockImplementation(
      (path) => path === mount || nativeExists(path),
    );
    vi.spyOn(NodeFS.default, "realpathSync").mockImplementation((path) => {
      if (path === mount) throw new Error("mount access denied");
      return nativeRealpath(path);
    });
    mockFileInspection({ status: 1, stdout: "", stderr: mountWarning(mount) });
    expect(appBundleIsInUse(fixture.targetPath)).toBe(false);
  });

  it("installs an idle fixture without quitting or launching", async () => {
    const fixture = idleFixture();
    await expect(installDmgIfIdle(fixture.dmgPath, fixture.options)).resolves.toEqual({
      status: "installed",
      version: "1.2.3-nightly.1",
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("new");
    expect(fixture.commands).not.toContain("open");
    expect(fixture.commands).not.toContain("osascript");
    expect(fixture.commands.filter((command) => command === "/bin/ps")).toHaveLength(2);
  });

  it("defers before preparing a busy bundle", async () => {
    const fixture = idleFixture();
    await expect(
      installDmgIfIdle(fixture.dmgPath, {
        ...fixture.options,
        runCommand: () => `42 ${fixture.targetPath}/Contents/MacOS/LastCode`,
      }),
    ).resolves.toEqual({ status: "deferred", reason: "bundle-in-use" });
    expect(fixture.commands).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
  });

  it("defers if the bundle becomes busy during preparation and releases the lock", async () => {
    const fixture = idleFixture();
    fixture.state.busyOnSecondRead = true;
    await expect(installDmgIfIdle(fixture.dmgPath, fixture.options)).resolves.toEqual({
      status: "deferred",
      reason: "bundle-in-use",
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
    const release = acquireInstallLock(fixture.options.lockDirectory);
    release();
    expect(NodeFS.existsSync(temporaryAppPaths(fixture.targetPath).staging)).toBe(false);
  });

  it("revalidates eligibility before the final inspection and leaves the old bundle on rejection", async () => {
    const fixture = idleFixture();
    await expect(
      installDmgIfIdle(fixture.dmgPath, {
        ...fixture.options,
        beforeReplace: () => {
          throw new Error("version ceiling lowered");
        },
      }),
    ).rejects.toThrow("version ceiling lowered");
    expect(fixture.commands.filter((command) => command === "/bin/ps")).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
  });

  it.each(["success", "busy", "inspection-error", "rename-error"])(
    "holds and releases the eligibility lock across %s",
    async (scenario) => {
      const fixture = idleFixture();
      let locked = false;
      let releaseCount = 0;
      let processReads = 0;
      let prepared;
      fixture.state.busyOnSecondRead = scenario === "busy";
      const runCommand = (command, args, options) => {
        if (command === "/bin/ps" && ++processReads === 2) {
          expect(locked).toBe(true);
          if (scenario === "inspection-error") throw new Error("inspection denied");
        }
        if (command === "/usr/sbin/lsof" && processReads === 2) expect(locked).toBe(true);
        return fixture.options.runCommand(command, args, options);
      };
      const installation = installDmgIfIdle(fixture.dmgPath, {
        ...fixture.options,
        runCommand,
        beforeReplace: (value) => {
          prepared = value;
          locked = true;
          if (scenario === "rename-error") NodeFS.rmSync(prepared.staging, { recursive: true });
          return () => {
            expect(locked).toBe(true);
            expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe(
              scenario === "success" ? "new" : "old",
            );
            expect(prepared.oldAppMoved).toBe(false);
            locked = false;
            releaseCount += 1;
          };
        },
      });
      if (scenario.endsWith("error")) await expect(installation).rejects.toThrow();
      else
        await expect(installation).resolves.toMatchObject({
          status: scenario === "busy" ? "deferred" : "installed",
        });
      expect(locked).toBe(false);
      expect(releaseCount).toBe(1);
    },
  );

  it.each(["architecture", "signature"])("enforces preparation %s checks", async (field) => {
    const fixture = idleFixture();
    fixture.state[field] = field === "architecture" ? "arm64" : "certificate";
    await expect(prepareDmgInstall(fixture.dmgPath, fixture.options)).rejects.toThrow("Expected");
    expect(fixture.commands).not.toContain("ditto");
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
  });

  it("leaves the installed bundle untouched if final process inspection fails", async () => {
    const fixture = idleFixture();
    let processReads = 0;
    const runCommand = (command, args, options) => {
      if (command === "/bin/ps" && ++processReads === 2) throw new Error("inspection denied");
      return fixture.options.runCommand(command, args, options);
    };
    await expect(
      installDmgIfIdle(fixture.dmgPath, { ...fixture.options, runCommand }),
    ).rejects.toThrow("inspection denied");
    expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
    expect(NodeFS.existsSync(temporaryAppPaths(fixture.targetPath).staging)).toBe(false);
    const release = acquireInstallLock(fixture.options.lockDirectory);
    release();
  });

  it("preserves the untouched target when the first rename fails", async () => {
    const fixture = idleFixture();
    const prepared = await prepareDmgInstall(fixture.dmgPath, fixture.options);
    NodeFS.mkdirSync(prepared.backup);
    NodeFS.writeFileSync(NodePath.join(prepared.backup, "occupied"), "block rename");
    try {
      await expect(replacePreparedApp(prepared, { launch: false })).rejects.toThrow();
      expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
    } finally {
      cleanupPreparedInstall(prepared, fixture.options);
    }
  });

  it("restores an app that an interrupted install left aside before preparing", async () => {
    const fixture = idleFixture();
    const root = NodePath.dirname(fixture.targetPath);
    const exited = NodeChildProcess.spawnSync(process.execPath, ["--eval", ""]).pid;
    const backup = NodePath.join(root, `.LastCode.previous-${exited}.app`);
    const staging = NodePath.join(root, `.LastCode.install-${exited}.app`);
    // A live installer's bundles, here this process's parent, are never touched.
    const liveStaging = NodePath.join(root, `.LastCode.install-${process.ppid}.app`);
    NodeFS.renameSync(fixture.targetPath, backup);
    NodeFS.mkdirSync(staging);
    NodeFS.mkdirSync(liveStaging);

    const release = acquireInstallLock(fixture.options.lockDirectory);
    try {
      await expect(prepareDmgInstall(fixture.dmgPath, fixture.options)).rejects.toThrow(
        "Another LastCode install is already running",
      );
      expect(NodeFS.existsSync(fixture.targetPath)).toBe(false);
      expect(NodeFS.existsSync(backup)).toBe(true);
      expect(NodeFS.existsSync(staging)).toBe(true);
    } finally {
      release();
    }

    const prepared = await prepareDmgInstall(fixture.dmgPath, fixture.options);
    try {
      expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
      expect(NodeFS.existsSync(backup)).toBe(false);
      expect(NodeFS.existsSync(staging)).toBe(false);
      expect(NodeFS.existsSync(liveStaging)).toBe(true);
    } finally {
      cleanupPreparedInstall(prepared, fixture.options);
    }
  });

  it("continues preparing when the recovery directory does not exist yet", async () => {
    const fixture = idleFixture();
    const targetPath = NodePath.join(NodePath.dirname(fixture.targetPath), "new", "LastCode.app");
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const options = { ...fixture.options, targetPath };
    const prepared = await prepareDmgInstall(fixture.dmgPath, options);
    try {
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Warning: could not clean up an interrupted install"),
      );
      expect(NodeFS.readFileSync(NodePath.join(prepared.staging, "version"), "utf8")).toBe("new");
    } finally {
      cleanupPreparedInstall(prepared, options);
    }
  });

  it("retains the previous app even after the managed replacement launches", async () => {
    const fixture = idleFixture();
    const t3Home = NodePath.join(fixture.options.lockDirectory, "state");
    const options = { ...fixture.options, trackOutcome: true, t3Home };
    const prepared = await prepareDmgInstall(fixture.dmgPath, options);
    const stateDir = NodePath.join(t3Home, "userdata");
    const outcome = (path = fixture.targetPath, version = prepared.version, state = stateDir) =>
      readDesktopInstallOutcome(options.lockDirectory, path, version, state);
    const contents = (path) => NodeFS.readFileSync(NodePath.join(path, "version"), "utf8");
    try {
      await finishCommittedInstall(
        prepared,
        { pid: 42, identity: "fixture" },
        {
          waitForParentExit: async () => {
            expect(contents(fixture.targetPath)).toBe("old");
            expect(outcome()).toMatchObject({ status: "pending", matchesReplacement: false });
          },
          launchApp: async (target) => {
            expect(contents(target)).toBe("new");
            expect(contents(prepared.backup)).toBe("old");
          },
        },
      );
    } finally {
      cleanupPreparedInstall(prepared, options);
    }
    expect(contents(prepared.backup)).toBe("old");
    const another = NodePath.join(t3Home, "Other.app");
    NodeFS.mkdirSync(t3Home);
    NodeFS.cpSync(fixture.targetPath, another, { recursive: true });
    expect(outcome(another)).toBeNull();
    expect(outcome(fixture.targetPath, "9.9.9")).toBeNull();
    expect(outcome(fixture.targetPath, prepared.version, "/different/userdata")).toBeNull();
    expect(outcome()).toMatchObject({ status: "pending", matchesReplacement: true });

    await recordReplacementBackend(outcome(), false);
    expect(outcome()?.status).toBe("backend-failed");
    expect(contents(prepared.backup)).toBe("old");
    await recordReplacementBackend(outcome(), true);
    expect(outcome()?.status).toBe("healthy");
    expect(NodeFS.existsSync(prepared.backup)).toBe(false);
    await recordReplacementBackend(outcome(), false);
    expect(outcome()?.status).toBe("healthy");
  });

  it.each([
    { scenario: "unconfirmed replacement", confirmed: false, sameBundle: true, otherMtime: 20 },
    { scenario: "healthy replacement", confirmed: true, sameBundle: true, otherMtime: 10 },
    {
      scenario: "older copy across a failed retry",
      confirmed: false,
      sameBundle: false,
      otherMtime: 20,
    },
  ])(
    "recovers only the recorded app from a later legacy swap ($scenario)",
    async ({ confirmed, sameBundle, otherMtime }) => {
      const fixture = idleFixture();
      const root = fixture.options.lockDirectory;
      const options = { ...fixture.options, trackOutcome: true, t3Home: root };
      const prepared = await prepareDmgInstall(fixture.dmgPath, options);
      try {
        await finishCommittedInstall(
          prepared,
          { pid: 42, identity: "fixture" },
          {
            waitForParentExit: async () => {},
            launchApp: async () => {},
          },
        );
      } finally {
        cleanupPreparedInstall(prepared, options);
      }
      const outcome = readDesktopInstallOutcome(
        root,
        prepared.targetPath,
        prepared.version,
        NodePath.join(root, "userdata"),
      );
      if (confirmed) await recordReplacementBackend(outcome, true);
      const exited = NodeChildProcess.spawnSync(process.execPath, ["--eval", ""]).pid;
      const legacy = temporaryAppPaths(fixture.targetPath, exited);
      const unrelatedPid = NodeChildProcess.spawnSync(process.execPath, ["--eval", ""]).pid;
      const unrelated = temporaryAppPaths(fixture.targetPath, unrelatedPid);
      NodeFS.mkdirSync(unrelated.backup);
      NodeFS.utimesSync(unrelated.backup, otherMtime, otherMtime);
      if (sameBundle) {
        NodeFS.renameSync(fixture.targetPath, legacy.backup);
      } else {
        NodeFS.renameSync(fixture.targetPath, NodePath.join(root, "detached.app"));
        NodeFS.cpSync(prepared.backup, legacy.backup, { recursive: true });
      }
      NodeFS.mkdirSync(legacy.staging);
      NodeFS.utimesSync(legacy.backup, 15, 15);

      const next = await prepareDmgInstall(fixture.dmgPath, options);
      try {
        expect(NodeFS.existsSync(fixture.targetPath)).toBe(sameBundle);
        if (sameBundle)
          expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe(
            "new",
          );
        expect(NodeFS.existsSync(legacy.backup)).toBe(!sameBundle);
        expect(NodeFS.existsSync(prepared.backup)).toBe(!confirmed);
        expect(NodeFS.existsSync(unrelated.backup)).toBe(true);
        if (!sameBundle) {
          await expect(
            finishCommittedInstall(
              next,
              { pid: 42, identity: "fixture" },
              {
                waitForParentExit: async () => {
                  throw new Error("retry aborted");
                },
                waitUntilParentGone: async () => true,
                isRunning: () => false,
                launchApp: async () => {
                  throw new Error("unexpected launch");
                },
              },
            ),
          ).rejects.toThrow("retry aborted");
        }
      } finally {
        cleanupPreparedInstall(next, options);
      }
      const following = await prepareDmgInstall(fixture.dmgPath, options);
      try {
        expect(NodeFS.existsSync(fixture.targetPath)).toBe(sameBundle);
        expect(NodeFS.existsSync(legacy.backup)).toBe(!sameBundle);
        expect(NodeFS.existsSync(unrelated.backup)).toBe(true);
        expect(NodeFS.existsSync(prepared.backup)).toBe(!confirmed);
      } finally {
        cleanupPreparedInstall(following, options);
      }
    },
  );

  it.each(["before the swap", "after the swap"])(
    "records a failed handoff %s and only relaunches a known old app",
    async (when) => {
      const fixture = idleFixture();
      const root = fixture.options.lockDirectory;
      const options = { ...fixture.options, trackOutcome: true, t3Home: root };
      const prepared = await prepareDmgInstall(fixture.dmgPath, options);
      const launches = [];
      const reset = vi.fn();
      const marker = NodePath.join(root, ".lastcode", "local-updates", "screen-recording-reset");
      const contents = (path) => NodeFS.readFileSync(NodePath.join(path, "version"), "utf8");
      try {
        await expect(
          finishCommittedInstall(
            prepared,
            { pid: 42, identity: "fixture" },
            {
              waitForParentExit: async () => {
                if (when === "before the swap") throw new Error("fixture wait failed");
              },
              waitUntilParentGone: async () => true,
              isRunning: () => false,
              reminderHome: root,
              runCommand: (_command, args) => `# designated => cdhash H"${args.at(-1)}"`,
              resetScreenRecordingPermission: reset,
              launchApp: async (path) => {
                launches.push(contents(path));
                if (when === "after the swap") throw new Error("fixture launch failed");
              },
            },
          ),
        ).rejects.toThrow(
          when === "before the swap" ? "fixture wait failed" : "fixture launch failed",
        );
      } finally {
        cleanupPreparedInstall(prepared, options);
      }
      const result = readDesktopInstallOutcome(
        root,
        prepared.targetPath,
        prepared.version,
        NodePath.join(root, "userdata"),
      );
      if (when === "before the swap") {
        expect(launches).toEqual(["old"]);
        expect(result).toMatchObject({ status: "failed-before-swap", matchesReplacement: false });
        expect(contents(prepared.targetPath)).toBe("old");
        expect(reset).not.toHaveBeenCalled();
        expect(NodeFS.existsSync(marker)).toBe(false);
      } else {
        expect(launches).toEqual(["new"]);
        expect(result).toMatchObject({ status: "launch-failed", matchesReplacement: true });
        expect(contents(prepared.targetPath)).toBe("new");
        expect(contents(prepared.backup)).toBe("old");
        expect(reset).toHaveBeenCalledTimes(1);
        expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");

        // The next attempt must keep the first copy even if it installs the same version.
        const next = await prepareDmgInstall(fixture.dmgPath, options);
        try {
          await finishCommittedInstall(
            next,
            { pid: 42, identity: "fixture" },
            {
              waitForParentExit: async () => {},
              launchApp: async () => {},
            },
          );
          await recordReplacementBackend(result, true);
          expect(contents(prepared.backup)).toBe("old");
          expect(contents(next.backup)).toBe("new");
          const replacement = readDesktopInstallOutcome(
            root,
            next.targetPath,
            next.version,
            NodePath.join(root, "userdata"),
          );
          expect(replacement?.record.id).not.toBe(result.record.id);
          await recordReplacementBackend(replacement, true);
          expect(NodeFS.existsSync(prepared.backup)).toBe(false);
          expect(NodeFS.existsSync(next.backup)).toBe(false);
        } finally {
          cleanupPreparedInstall(next, options);
        }
      }
    },
  );

  it.each([false, true])(
    "recovers across installer process exit (replacement published: %s)",
    async (published) => {
      const fixture = idleFixture();
      const root = fixture.options.lockDirectory;
      const version = fixture.options.expectedVersion;
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import * as fs from "node:fs";
      import { beginInstallOutcome, retainedBundlePath } from ${JSON.stringify(new URL("./lastcode-install-outcome.mjs", import.meta.url).href)};
      import { temporaryAppPaths } from ${JSON.stringify(new URL("./lastcode-install.mjs", import.meta.url).href)};
      const [targetPath, t3Home, version, published] = process.argv.slice(1);
      const { staging } = temporaryAppPaths(targetPath);
      fs.mkdirSync(staging);
      const outcome = beginInstallOutcome(t3Home, { targetPath, t3Home, version, staging });
      fs.renameSync(targetPath, retainedBundlePath(targetPath, outcome.record.id));
      if (published === "true") fs.renameSync(staging, targetPath);
      process.kill(process.pid, "SIGKILL");
    `,
          fixture.targetPath,
          root,
          version,
          String(published),
        ],
        { encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.signal).toBe("SIGKILL");
      const otherPid = NodeChildProcess.spawnSync(process.execPath, ["--eval", ""]).pid;
      const unrelated = temporaryAppPaths(fixture.targetPath, otherPid);
      NodeFS.mkdirSync(unrelated.backup);
      const next = await prepareDmgInstall(fixture.dmgPath, fixture.options);
      try {
        expect(NodeFS.existsSync(unrelated.backup)).toBe(true);
        expect(NodeFS.existsSync(temporaryAppPaths(fixture.targetPath, result.pid).staging)).toBe(
          false,
        );
        const outcome = readDesktopInstallOutcome(
          root,
          fixture.targetPath,
          version,
          NodePath.join(root, "userdata"),
        );
        expect(outcome).toMatchObject({
          status: published ? "pending" : "failed-before-swap",
          matchesReplacement: published,
        });
        const backup = retainedBundlePath(fixture.targetPath, outcome.record.id);
        if (published) {
          expect(NodeFS.readFileSync(NodePath.join(backup, "version"), "utf8")).toBe("old");
          await recordReplacementBackend(outcome, true);
          expect(NodeFS.existsSync(backup)).toBe(false);
        } else {
          expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe(
            "old",
          );
          expect(NodeFS.existsSync(backup)).toBe(false);
        }
      } finally {
        cleanupPreparedInstall(next, fixture.options);
      }
    },
  );

  it("rolls back a failed staging rename without launching", async () => {
    const fixture = idleFixture();
    const prepared = await prepareDmgInstall(fixture.dmgPath, fixture.options);
    NodeFS.rmSync(prepared.staging, { recursive: true });
    try {
      await expect(
        replacePreparedApp(prepared, {
          launch: false,
          launchApp: () => {
            throw new Error("must not launch");
          },
        }),
      ).rejects.toThrow("ENOENT");
      expect(NodeFS.readFileSync(NodePath.join(fixture.targetPath, "version"), "utf8")).toBe("old");
    } finally {
      cleanupPreparedInstall(prepared, fixture.options);
    }
  });

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

  it("resets Screen Recording only when the installed app's code requirement changes", () => {
    const root = temporaryDirectory();
    const current = NodePath.join(root, "current.app");
    const replacement = NodePath.join(root, "replacement.app");
    NodeFS.mkdirSync(current);
    NodeFS.mkdirSync(replacement);
    let nextRequirement = 'cdhash H"old"';
    const runCommand = (_command, args, options) => {
      expect(options).toBeUndefined(); // codesign writes the requirement to stdout.
      return `Executable=${args[2]}\n# designated => ${args[2] === current ? 'cdhash H"old"' : nextRequirement}`;
    };
    expect(shouldResetScreenRecordingPermission(current, replacement, { runCommand })).toBe(false);
    nextRequirement = 'cdhash H"new"';
    expect(shouldResetScreenRecordingPermission(current, replacement, { runCommand })).toBe(true);
    expect(
      shouldResetScreenRecordingPermission(NodePath.join(root, "not-installed.app"), replacement, {
        runCommand,
      }),
    ).toBe(false);

    const commands = [];
    resetScreenRecordingPermission((command, args, options) => {
      commands.push([command, args, options]);
    });
    expect(commands).toEqual([
      ["tccutil", ["reset", "ScreenCapture", "codes.lastobelus.lastcode"], { timeoutMs: 10_000 }],
    ]);
    expect(() =>
      resetScreenRecordingPermission(() => {
        throw new Error("tccutil failed");
      }),
    ).toThrow("tccutil failed");
  });

  it("resets the permission only after the replacement has launched", async () => {
    const root = temporaryDirectory();
    const targetPath = NodePath.join(root, "LastCode.app");
    const staging = NodePath.join(root, ".LastCode.install.app");
    const backup = NodePath.join(root, ".LastCode.previous.app");
    NodeFS.mkdirSync(targetPath);
    NodeFS.mkdirSync(staging);
    const steps = [];
    const marker = NodePath.join(root, ".lastcode/local-updates/screen-recording-reset");
    await replacePreparedApp(
      { targetPath, staging, backup, oldAppMoved: false },
      {
        reminderHome: root,
        runCommand: (_command, args) =>
          `# designated => cdhash H"${args[2] === targetPath ? "old" : "new"}"`,
        resetScreenRecordingPermission: () => {
          expect(NodeFS.readFileSync(marker, "utf8")).toBe("pending\n");
          steps.push("reset");
        },
        launchApp: async () => {
          expect(NodeFS.readFileSync(marker, "utf8")).toBe("pending\n");
          steps.push("launch");
        },
      },
    );
    expect(steps).toEqual(["launch", "reset"]);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");
  });

  it("keeps the launched replacement and reminds when tccutil fails", async () => {
    const root = temporaryDirectory();
    const targetPath = NodePath.join(root, "LastCode.app");
    const staging = NodePath.join(root, ".LastCode.install.app");
    const backup = NodePath.join(root, ".LastCode.previous.app");
    NodeFS.mkdirSync(targetPath);
    NodeFS.writeFileSync(NodePath.join(targetPath, "version"), "old");
    NodeFS.mkdirSync(staging);
    NodeFS.writeFileSync(NodePath.join(staging, "version"), "new");
    const marker = NodePath.join(root, ".lastcode/local-updates/screen-recording-reset");
    const originalError = console.error;
    const warnings = [];
    console.error = (message) => warnings.push(message);
    try {
      await replacePreparedApp(
        { targetPath, staging, backup, oldAppMoved: false },
        {
          reminderHome: root,
          runCommand: (_command, args) =>
            `# designated => cdhash H"${args[2] === targetPath ? "old" : "new"}"`,
          resetScreenRecordingPermission: () => {
            throw new Error("tccutil failed");
          },
          launchApp: async () => {},
        },
      );
    } finally {
      console.error = originalError;
    }
    expect(warnings[0]).toContain("tccutil failed");
    expect(NodeFS.readFileSync(NodePath.join(targetPath, "version"), "utf8")).toBe("new");
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");
    expect(NodeFS.existsSync(backup)).toBe(false);
  });

  it("validates certificate-free bundle, version, and exact executable architecture", () => {
    const root = temporaryDirectory();
    const appPath = NodePath.join(root, "LastCode.app");
    NodeFS.mkdirSync(appPath);
    const runCommand = (command, args) => {
      if (command === "/usr/libexec/PlistBuddy") {
        if (args[1] === "Print:CFBundleIdentifier") return "codes.lastobelus.lastcode";
        if (args[1] === "Print:CFBundleShortVersionString") {
          return "1.2.3-nightly.20260821.7.2";
        }
        if (args[1] === "Print:CFBundleExecutable") return "LastCode";
      }
      if (command === "codesign" && args[0] === "-d") {
        return "Signature=adhoc\nTeamIdentifier=not set";
      }
      if (command === "codesign") return "";
      if (command === "lipo") return "x86_64";
      throw new Error(`Unexpected ${command}`);
    };
    expect(
      validateAppBundle(appPath, {
        expectedArchitecture: "x86_64",
        expectedVersion: "1.2.3-nightly.20260821.7.2",
        runCommand,
        signaturePolicy: "adhoc",
      }),
    ).toBe("1.2.3-nightly.20260821.7.2");
    expect(() =>
      validateAppBundle(appPath, {
        expectedArchitecture: "arm64",
        runCommand,
        signaturePolicy: "adhoc",
      }),
    ).toThrow("Expected arm64");
  });

  it("mounts DMGs readonly and binds validation to the expected hash", async () => {
    const root = temporaryDirectory();
    const dmgPath = NodePath.join(root, "LastCode.dmg");
    NodeFS.writeFileSync(dmgPath, "validated dmg");
    const expectedSha256 = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(dmgPath))
      .digest("hex");
    const commands = [];
    const runCommand = (command, args) => {
      commands.push([command, args]);
      if (command === "hdiutil" && args[0] === "attach") {
        NodeFS.mkdirSync(NodePath.join(args[4], "LastCode.app"));
        return "";
      }
      if (command === "hdiutil") return "";
      if (command === "/usr/libexec/PlistBuddy") {
        if (args[1] === "Print:CFBundleIdentifier") return "codes.lastobelus.lastcode";
        if (args[1] === "Print:CFBundleShortVersionString") return "1.2.3-nightly.1";
        if (args[1] === "Print:CFBundleExecutable") return "LastCode";
      }
      if (command === "codesign" && args[0] === "-d") {
        return "Signature=adhoc\nTeamIdentifier=not set";
      }
      if (command === "codesign") return "";
      if (command === "lipo") return "x86_64";
      throw new Error(`Unexpected ${command}`);
    };

    await expect(
      validateDmgArtifact(dmgPath, {
        allowNonDarwin: true,
        expectedArchitecture: "x86_64",
        expectedSha256,
        expectedVersion: "1.2.3-nightly.1",
        runCommand,
        signaturePolicy: "adhoc",
      }),
    ).resolves.toMatchObject({ sha256: expectedSha256, version: "1.2.3-nightly.1" });
    expect(commands[0][0]).toBe("hdiutil");
    expect(commands[0][1]).toContain("-readonly");
    await expect(
      validateDmgArtifact(dmgPath, {
        allowNonDarwin: true,
        expectedSha256: "b".repeat(64),
        runCommand,
      }),
    ).rejects.toThrow("DMG checksum mismatch");
  });

  it("removes validation mounts and preserves the primary error when detach fails", async () => {
    const root = temporaryDirectory();
    const dmgPath = NodePath.join(root, "LastCode.dmg");
    NodeFS.writeFileSync(dmgPath, "invalid mounted app");
    const commands = [];
    let mountPoint;
    const runCommand = (command, args) => {
      commands.push([command, args]);
      if (command === "hdiutil" && args[0] === "attach") {
        mountPoint = args[4];
        NodeFS.mkdirSync(NodePath.join(mountPoint, "LastCode.app"));
        return "";
      }
      if (command === "hdiutil") throw new Error("injected detach failure");
      if (command === "/usr/libexec/PlistBuddy" && args[1] === "Print:CFBundleIdentifier") {
        return "com.example.untrusted";
      }
      throw new Error(`Unexpected ${command}`);
    };

    await expect(
      validateDmgArtifact(dmgPath, { allowNonDarwin: true, runCommand }),
    ).rejects.toThrow("Expected bundle codes.lastobelus.lastcode");
    expect(NodeFS.existsSync(mountPoint)).toBe(false);
    expect(commands.filter(([command]) => command === "hdiutil").map(([, args]) => args)).toEqual([
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath],
      ["detach", mountPoint],
      ["detach", "-force", mountPoint],
    ]);
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

  const APP_IDENTITY =
    "Sat Nov  7 13:50:01 2026 /Applications/LastCode.app/Contents/MacOS/LastCode";
  const fakeParent = ({ exitsAfter = Number.POSITIVE_INFINITY, identity = APP_IDENTITY } = {}) => {
    let elapsed = 0;
    const sent = [];
    return {
      sent,
      options: {
        isAlive: () => elapsed < exitsAfter,
        now: () => elapsed,
        processIdentity: () => identity,
        signal: (pid, signal) => sent.push([pid, signal, elapsed]),
        wait: (ms) => {
          elapsed += ms;
          return Promise.resolve();
        },
      },
    };
  };

  it.each([
    { name: "quits within the grace period", exitsAfter: 10_000, signals: [] },
    { name: "exits after SIGTERM", exitsAfter: 31_000, signals: [["SIGTERM", 30_000]] },
    {
      name: "needs SIGKILL",
      exitsAfter: 46_000,
      signals: [
        ["SIGTERM", 30_000],
        ["SIGKILL", 45_000],
      ],
    },
  ])("waits for a committed parent that $name", async ({ exitsAfter, signals }) => {
    const parent = fakeParent({ exitsAfter });
    await waitForParentExit(62_323, APP_IDENTITY, parent.options);
    expect(parent.sent).toEqual(signals.map(([signal, at]) => [62_323, signal, at]));
  });

  it("treats a reused parent PID as exited without signalling it", async () => {
    const parent = fakeParent({
      identity: "Sat Nov  7 13:58:20 2026 /Applications/LastCode.app/Contents/MacOS/LastCode",
    });
    await waitForParentExit(62_323, APP_IDENTITY, parent.options);
    expect(parent.sent).toEqual([]);
  });

  it.each([
    { name: "an unknown identity", identity: "" },
    {
      name: "an app outside the target",
      identity: "Sat Nov  7 13:50:01 2026 /tmp/LastCode.app/Contents/MacOS/LastCode",
    },
  ])("never signals a parent with $name, and waits longer for it", async ({ identity }) => {
    const parent = fakeParent({ identity });
    await expect(waitForParentExit(62_323, identity, parent.options)).rejects.toThrow(
      "LastCode process 62323 did not quit within 600 seconds.",
    );
    expect(parent.sent).toEqual([]);
  });

  it.each([
    { name: "the parent outlasted the wait", failure: "wait", relaunched: true },
    { name: "the swap fails before moving anything", failure: "replace", relaunched: true },
    {
      name: "the swap already relaunched the old app",
      failure: "replace-relaunched",
      relaunched: false,
    },
    { name: "rollback left the original aside", failure: "replace-aside", relaunched: true },
    { name: "rollback left a partial new bundle", failure: "replace-partial", relaunched: false },
    {
      name: "a first install left a partial bundle",
      failure: "replace-fresh-partial",
      relaunched: false,
    },
  ])(
    "leaves an app running when a committed install fails because $name",
    async ({ failure, relaunched }) => {
      const root = temporaryDirectory();
      const targetPath = NodePath.join(root, "LastCode.app");
      if (failure !== "replace-fresh-partial") NodeFS.mkdirSync(targetPath);
      const backup = `${targetPath}.previous`;
      const launches = [];
      let running = false;
      await expect(
        finishCommittedInstall(
          { targetPath, backup, version: "0.1.8-nightly.20261107.4301", oldAppMoved: false },
          { pid: 62_323, identity: "" },
          {
            waitForParentExit: async () => {
              if (failure !== "wait") return;
              // The parent is still quitting, so it still counts as a running app.
              running = true;
              throw new Error("LastCode process 62323 did not quit");
            },
            waitUntilParentGone: async () => {
              running = false;
              return true;
            },
            replacePreparedApp: async (prepared) => {
              if (failure === "replace-relaunched") running = true;
              if (failure === "replace-aside") NodeFS.renameSync(targetPath, backup);
              if (failure === "replace-fresh-partial") NodeFS.mkdirSync(targetPath);
              if (failure === "replace-aside" || failure === "replace-partial") {
                prepared.oldAppMoved = true;
              }
              throw new Error("rename failed");
            },
            isRunning: () => running,
            launchApp: async (appPath) => launches.push(appPath),
          },
        ),
      ).rejects.toThrow(failure === "wait" ? "did not quit" : "rename failed");
      expect(launches).toEqual(relaunched ? [targetPath] : []);
      NodeFS.rmSync(backup, { force: true, recursive: true });
    },
  );

  it("gives up on a handoff that never receives COMMIT or CANCEL", async () => {
    vi.useFakeTimers();
    const stream = new NodeStream.PassThrough();
    const command = readHandoffCommand(stream, 600_000);
    vi.advanceTimersByTime(600_000);
    await expect(command).rejects.toThrow("no COMMIT or CANCEL within 600 seconds");
    vi.useRealTimers();
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

  it("can wait for startup without relaunching the app", async () => {
    let elapsed = 0;
    let launches = 0;
    await expect(
      launchApp("/Applications/LastCode.app", {
        isRunning: () => false,
        maxLaunchAttempts: 1,
        now: () => elapsed,
        pollIntervalMs: 250,
        retryIntervalMs: 100,
        runCommand: () => {
          launches += 1;
        },
        stabilityMs: 500,
        timeoutMs: 1_000,
        wait: async (delay) => {
          elapsed += delay;
        },
      }),
    ).rejects.toThrow("did not remain running");
    expect(launches).toBe(1);
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
    const marker = NodePath.join(root, ".lastcode/local-updates/screen-recording-reset");
    NodeFS.mkdirSync(NodePath.dirname(marker), { recursive: true });
    NodeFS.writeFileSync(marker, "ready\n");

    const launchAttempts = [];
    let resetCount = 0;
    await expect(
      replacePreparedApp(prepared, {
        reminderHome: root,
        runCommand: (_command, args) =>
          `# designated => cdhash H"${args[2] === targetPath ? "old" : "new"}"`,
        resetScreenRecordingPermission: () => {
          resetCount += 1;
        },
        launchApp: async (path) => {
          launchAttempts.push(path);
          throw new Error("launch failed");
        },
      }),
    ).rejects.toThrow("launch failed");
    expect(NodeFS.readFileSync(NodePath.join(targetPath, "version"), "utf8")).toBe("old");
    expect(NodeFS.existsSync(backup)).toBe(false);
    expect(launchAttempts).toEqual([targetPath, targetPath]);
    expect(resetCount).toBe(0);
    expect(NodeFS.readFileSync(marker, "utf8")).toBe("ready\n");
  });

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-install.mjs")).toContain(
      "env MISE_ACTIVATE_AGGRESSIVE=1 mise exec node@26.13.1 -- node '/tmp/Last Code/lastcode-install.mjs' \"$@\"",
    );
  });

  it("refreshes a previously installed standalone installer and its companions", () => {
    const home = temporaryDirectory();
    const bin = NodePath.join(home, ".lastcode", "bin");
    const exposed = NodePath.join(home, ".local", "bin", "lastcode-install");
    const modulePath = NodePath.join(bin, "lastcode-install.mjs");
    const launcher = NodePath.join(bin, "lastcode-install");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(exposed), { recursive: true });
    NodeFS.writeFileSync(
      modulePath,
      "// LastCode managed command: lastcode-install\n// Previous installer\n",
    );
    NodeFS.writeFileSync(launcher, renderLauncher(modulePath));
    NodeFS.symlinkSync(launcher, exposed);
    const refreshed = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "lastcode-install.mjs"), "--install"],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    expect(refreshed.stderr).toBe("");
    expect(refreshed.status).toBe(0);
    expect(NodeFS.readFileSync(modulePath, "utf8")).toContain("lastcode-install-outcome.mjs");
    expect(NodeFS.readlinkSync(exposed)).toBe(launcher);

    const outcomeModule = NodePath.join(bin, "lastcode-install-outcome.mjs");
    expect(NodeFS.readFileSync(outcomeModule, "utf8")).toContain(
      "LastCode managed companion: lastcode-install-outcome",
    );

    expect(
      NodeFS.readFileSync(NodePath.join(home, ".lastcode", "bin", "lastcode-lock.mjs"), "utf8"),
    ).toContain("LastCode managed companion: lastcode-lock");
    const result = NodeChildProcess.spawnSync(process.execPath, [modulePath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: lastcode-install");

    uninstallCommand(home);
    expect(NodeFS.existsSync(outcomeModule)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(home, ".lastcode", "bin", "lastcode-lock.mjs"))).toBe(
      false,
    );
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
    NodeFS.writeFileSync(
      NodePath.join(binDirectory, "lastcode-lock.mjs"),
      "// LastCode managed companion: lastcode-lock\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(binDirectory, "lastcode-build.mjs"),
      "// LastCode managed command: lastcode-build\n",
    );
    NodeFS.symlinkSync(target, exposed);

    uninstallCommand(home);
    expect(NodeFS.existsSync(exposed)).toBe(false);
    expect(NodeFS.existsSync(target)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(binDirectory, "lastcode-lock.mjs"))).toBe(true);

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
      ".lastcode/bin/lastcode-lock.mjs",
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
        ".lastcode/bin/lastcode-lock.mjs",
        ".lastcode/bin/lastcode-install",
      ]) {
        const candidatePath = NodePath.join(home, candidate);
        if (candidatePath !== foreignPath) expect(NodeFS.existsSync(candidatePath)).toBe(false);
      }
    }
  });
});
