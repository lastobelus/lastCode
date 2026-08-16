import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireInstallLock,
  discoverDmgs,
  installCommand,
  parseDmgChoice,
  parseHandoffOptions,
  parseOptions,
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

  it("restores the previous app when launch fails after the swap", () => {
    const root = temporaryDirectory();
    const targetPath = NodePath.join(root, "LastCode.app");
    const staging = NodePath.join(root, ".LastCode.install.app");
    const backup = NodePath.join(root, ".LastCode.previous.app");
    NodeFS.mkdirSync(targetPath);
    NodeFS.writeFileSync(NodePath.join(targetPath, "version"), "old");
    NodeFS.mkdirSync(staging);
    NodeFS.writeFileSync(NodePath.join(staging, "version"), "new");
    const prepared = { targetPath, staging, backup, oldAppMoved: false };

    expect(() =>
      replacePreparedApp(prepared, {
        runCommand: () => {
          throw new Error("launch failed");
        },
      }),
    ).toThrow("launch failed");
    expect(NodeFS.readFileSync(NodePath.join(targetPath, "version"), "utf8")).toBe("old");
    expect(NodeFS.existsSync(backup)).toBe(false);
  });

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-install.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/lastcode-install.mjs' \"$@\"",
    );
  });

  itMacOnly("serializes installers and releases the kernel lock", () => {
    const root = temporaryDirectory();
    const release = acquireInstallLock(root);
    expect(() => acquireInstallLock(root)).toThrow("already running");
    release();

    const lockPath = NodePath.join(root, "install.lock");
    expect(NodeFS.readFileSync(lockPath, "utf8")).toBe("");
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
