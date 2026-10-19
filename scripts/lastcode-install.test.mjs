import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

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
    expect(
      appBundleIsInUse("/Applications/LastCode.app", {
        runCommand: () => `42 /Applications/LastCode.app${suffix}`,
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

    uninstallCommand(home);
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
