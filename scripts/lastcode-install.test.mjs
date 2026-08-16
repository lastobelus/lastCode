import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireInstallLock,
  discoverDmgs,
  parseDmgChoice,
  parseOptions,
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

describe("LastCode userland install command", () => {
  it("parses an optional DMG or artifacts directory", () => {
    expect(parseOptions([])).toMatchObject({ dmgPath: undefined, install: false });
    expect(parseOptions(["/tmp/LastCode.dmg"]).dmgPath).toBe("/tmp/LastCode.dmg");
    expect(parseOptions(["--artifacts", "/tmp/builds"]).artifactsDirectory).toBe("/tmp/builds");
    expect(() => parseOptions(["one.dmg", "two.dmg"])).toThrow("Unexpected second DMG");
    expect(parseOptions(["--uninstall"]).uninstall).toBe(true);
    expect(() => parseOptions(["--uninstall", "one.dmg"])).toThrow("cannot be combined");
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

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-install.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/lastcode-install.mjs' \"$@\"",
    );
  });

  it("serializes installers and recovers an abandoned lock", () => {
    const root = temporaryDirectory();
    const release = acquireInstallLock(root);
    expect(() => acquireInstallLock(root)).toThrow("already running");
    release();

    const lockPath = NodePath.join(root, "install.lock");
    NodeFS.symlinkSync(JSON.stringify({ schemaVersion: 1, pid: 12345 }), lockPath);
    const releaseRecovered = acquireInstallLock(root, { isAlive: () => false });
    expect(NodeFS.lstatSync(lockPath).isSymbolicLink()).toBe(true);
    releaseRecovered();
    expect(NodeFS.existsSync(lockPath)).toBe(false);
  });

  it("uninstalls the managed installer and refuses a foreign PATH entry", () => {
    const home = temporaryDirectory();
    const binDirectory = NodePath.join(home, ".lastcode", "bin");
    const exposedDirectory = NodePath.join(home, ".local", "bin");
    const target = NodePath.join(binDirectory, "lastcode-install");
    const exposed = NodePath.join(exposedDirectory, "lastcode-install");
    NodeFS.mkdirSync(binDirectory, { recursive: true });
    NodeFS.mkdirSync(exposedDirectory, { recursive: true });
    NodeFS.writeFileSync(target, "managed");
    NodeFS.writeFileSync(NodePath.join(binDirectory, "lastcode-install.mjs"), "managed");
    NodeFS.symlinkSync(target, exposed);

    uninstallCommand(home);
    expect(NodeFS.existsSync(exposed)).toBe(false);
    expect(NodeFS.existsSync(target)).toBe(false);

    NodeFS.writeFileSync(exposed, "mine");
    expect(() => uninstallCommand(home)).toThrow("not managed by LastCode");
  });
});
