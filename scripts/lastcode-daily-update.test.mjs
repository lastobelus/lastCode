import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  installDailyUpdateService,
  parseDailyUpdateOptions,
  renderDailyUpdatePlist,
  runDailyUpdate,
} from "./lastcode-daily-update.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-daily-update-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(overrides = {}) {
  const calls = [];
  const working = (threadId, title = threadId) => ({ lifecycle: "working", threadId, title });
  return {
    calls,
    dependencies: {
      cleanupInstall: () => calls.push("cleanup"),
      listThreads: async () => ({ kind: "list", threads: [] }),
      prepareInstall: async () => {
        calls.push("prepare");
        return { prepared: true };
      },
      quitApp: async () => calls.push("quit"),
      replaceApp: async () => calls.push("replace"),
      resumeThread: async (threadId) => calls.push(`resume:${threadId}`),
      sendAndWait: async (threadId) => {
        calls.push(`pause:${threadId}`);
        return { kind: "completed", response: `Ready\nPAUSED FOR LASTCODE UPDATE` };
      },
      stageUpdate: async () => {
        calls.push("stage");
        return {
          pending: {
            dmgPath: "/tmp/LastCode.dmg",
            dmgSha256: "a".repeat(64),
            version: "1.2.3-nightly.20260824.1",
          },
        };
      },
      ...overrides,
    },
    working,
  };
}

describe("LastCode daily updater", () => {
  it("prepares before pausing, checks once for newcomers, and swaps once", async () => {
    const test = fixture();
    let listing = 0;
    test.dependencies.listThreads = async () => {
      test.calls.push(`list:${listing}`);
      listing += 1;
      return {
        kind: "list",
        threads:
          listing === 1
            ? [test.working("one"), { lifecycle: "active", threadId: "idle", title: "idle" }]
            : [test.working("one"), test.working("two")],
      };
    };

    await expect(runDailyUpdate({}, test.dependencies)).resolves.toEqual({
      status: "updated",
      version: "1.2.3-nightly.20260824.1",
    });
    expect(test.calls).toEqual([
      "stage",
      "prepare",
      "list:0",
      "pause:one",
      "list:1",
      "pause:two",
      "quit",
      "replace",
      "resume:one",
      "resume:two",
      "cleanup",
    ]);
  });

  it("does not quit when a working thread does not confirm it paused", async () => {
    let send = 0;
    const test = fixture({
      listThreads: async () => ({
        kind: "list",
        threads: [
          { lifecycle: "working", threadId: "one", title: "one" },
          { lifecycle: "working", threadId: "two", title: "two" },
        ],
      }),
      sendAndWait: async () => {
        send += 1;
        return {
          kind: "completed",
          response: send === 1 ? "PAUSED FOR LASTCODE UPDATE" : "Not ready",
        };
      },
    });

    await expect(runDailyUpdate({}, test.dependencies)).rejects.toThrow("did not confirm");
    expect(test.calls).toEqual(["stage", "prepare", "resume:one", "cleanup"]);
  });

  it("does nothing when no eligible update is pending", async () => {
    const test = fixture({ stageUpdate: async () => ({ status: "up-to-date" }) });
    await expect(runDailyUpdate({}, test.dependencies)).resolves.toEqual({
      status: "up-to-date",
    });
    expect(test.calls).toEqual([]);
  });

  it("supports one explicit bootstrap without installing it into the schedule", async () => {
    expect(parseDailyUpdateOptions(["run", "--bootstrap"])).toEqual({
      bootstrap: true,
      command: "run",
    });
    expect(() => parseDailyUpdateOptions(["install", "--bootstrap"])).toThrow(
      "accepted only by the run command",
    );
    const plist = renderDailyUpdatePlist({
      logDirectory: "/Users/me/Logs & More",
      modulePath: "/Users/me/lastcode-daily-update.mjs",
      nodePath: "/Users/me/node",
    });
    expect(plist).toContain("<integer>4</integer>");
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).not.toContain("--bootstrap");
    expect(plist).toContain(NodePath.join("Logs &amp; More", "daily-update.stderr.log"));

    const test = fixture({
      listThreads: async () => {
        throw new Error("bootstrap must not inspect threads");
      },
    });
    await expect(runDailyUpdate({ bootstrap: true }, test.dependencies)).resolves.toMatchObject({
      status: "updated",
    });
    expect(test.calls).toEqual(["stage", "prepare", "quit", "replace", "cleanup"]);
  });

  it("installs a daily LaunchAgent backed by standalone copied modules", () => {
    const home = temporaryDirectory();
    const calls = [];
    const installed = installDailyUpdateService({
      home,
      nodePath: "/managed/node",
      runCommand: (command, args, options) => calls.push({ args, command, options }),
    });

    expect(NodeFS.readFileSync(installed.plistPath, "utf8")).toContain("/managed/node");
    expect(
      NodeFS.existsSync(NodePath.join(installed.moduleDirectory, "lastcode-intel-stage.mjs")),
    ).toBe(true);
    expect(calls).toEqual([
      { command: "plutil", args: ["-lint", installed.plistPath], options: undefined },
      {
        command: "launchctl",
        args: ["bootout", installed.service],
        options: { allowFailure: true },
      },
      {
        command: "launchctl",
        args: ["bootstrap", `gui/${process.getuid()}`, installed.plistPath],
        options: undefined,
      },
    ]);
  });
});
