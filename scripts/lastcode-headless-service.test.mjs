import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  HEADLESS_SERVICE_LABEL,
  HEADLESS_SERVICE_PORT,
  installHeadlessService,
  parseHeadlessServiceOptions,
  renderHeadlessServicePlist,
  startHeadlessService,
  verifyHeadlessListener,
  waitForHeadlessService,
} from "./lastcode-headless-service.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-headless-"));
  temporaryDirectories.push(directory);
  return directory;
}

function descriptor(version) {
  return {
    environmentId: "htulo",
    label: "htulo",
    platform: { arch: "x64", os: "darwin" },
    serverVersion: version,
  };
}

describe("LastCode headless service", () => {
  it("renders the packaged server on htulo's fixed port without Electron UI", () => {
    const plist = renderHeadlessServicePlist({
      executablePath: "/Applications/LastCode.app/Contents/MacOS/LastCode",
      home: "/Users/me & you",
      logDirectory: "/Users/me & you/.lastcode/userdata/logs",
      serverPath: "/Applications/LastCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    });

    expect(plist).toContain(`<string>${HEADLESS_SERVICE_LABEL}</string>`);
    expect(plist).toContain(`<string>${String(HEADLESS_SERVICE_PORT)}</string>`);
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>--no-browser</string>");
    expect(plist).toContain("/Users/me &amp; you/.lastcode");
    expect(plist).not.toContain("open -a");
  });

  it("installs, restarts, and verifies the exact packaged server", async () => {
    const home = temporaryDirectory();
    const calls = [];
    const installed = await installHeadlessService({
      expectedVersion: "1.2.3",
      fetchDescriptor: async () => ({
        json: async () => descriptor("0.9.0"),
        ok: true,
        status: 200,
      }),
      home,
      readAppVersion: () => "1.2.3",
      readServerVersion: () => "0.9.0",
      runCommand: (command, args, options) => {
        calls.push({ args, command, options });
        return { status: command === "launchctl" && args[0] === "print" ? 1 : 0, stdout: "" };
      },
      uid: 501,
      verifyListenerOwnership: () => true,
    });

    expect(NodeFS.readFileSync(installed.plistPath, "utf8")).toContain(
      "/Applications/LastCode.app/Contents/MacOS/LastCode",
    );
    expect(calls).toEqual([
      { command: "plutil", args: ["-lint", installed.plistPath], options: undefined },
      {
        command: "launchctl",
        args: ["bootout", `gui/501/${HEADLESS_SERVICE_LABEL}`],
        options: { allowFailure: true },
      },
      {
        command: "launchctl",
        args: ["print", `gui/501/${HEADLESS_SERVICE_LABEL}`],
        options: { allowFailure: true, capture: true },
      },
      {
        command: "launchctl",
        args: ["bootstrap", "gui/501", installed.plistPath],
        options: undefined,
      },
    ]);
  });

  it("waits until the exact version is serving", async () => {
    const versions = ["0.8.0", "0.9.0"];
    await expect(
      waitForHeadlessService({
        expectedServerVersion: "0.9.0",
        fetchDescriptor: async () => ({
          json: async () => descriptor(versions.shift()),
          ok: true,
          status: 200,
        }),
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        timeoutMs: 20,
        verifyListenerOwnership: () => true,
        wait: async () => {},
      }),
    ).resolves.toMatchObject({ serverVersion: "0.9.0" });
  });

  it("requires port 3773 to belong to the LaunchAgent process", () => {
    const outputs = new Map([
      ["launchctl", { status: 0, stdout: "state = running\n\tpid = 4321\n" }],
      ["lsof", { status: 0, stdout: "p4321\n" }],
    ]);
    expect(
      verifyHeadlessListener({
        runCommand: (command) => outputs.get(command),
        uid: 501,
      }),
    ).toBe(true);
    outputs.set("lsof", { status: 0, stdout: "p9876\n" });
    expect(
      verifyHeadlessListener({
        runCommand: (command) => outputs.get(command),
        uid: 501,
      }),
    ).toBe(false);
  });

  it("does not start when the installed app is not the expected build", async () => {
    const calls = [];
    await expect(
      startHeadlessService({
        expectedVersion: "1.2.3",
        readAppVersion: () => "1.2.2",
        runCommand: (...args) => calls.push(args),
      }),
    ).rejects.toThrow("Installed LastCode is 1.2.2, expected 1.2.3");
    expect(calls).toEqual([]);
  });

  it("rejects unknown commands and extra arguments", () => {
    expect(parseHeadlessServiceOptions(["status"])).toEqual({ command: "status" });
    expect(() => parseHeadlessServiceOptions(["launch"])).toThrow("Usage:");
    expect(() => parseHeadlessServiceOptions(["start", "again"])).toThrow("Unexpected");
  });
});
