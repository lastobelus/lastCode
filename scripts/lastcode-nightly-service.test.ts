import { expect, it } from "vite-plus/test";

import {
  parseNightlyServiceArgs,
  renderLaunchAgentPlist,
  runNowArguments,
  shouldRequestRunNow,
  shouldRunNightlyServiceCommand,
} from "./lastcode-nightly-service.ts";

it("renders the deployment-defined interval in a source-only launch agent", () => {
  const plist = renderLaunchAgentPlist({
    intervalSeconds: 1234,
    repoRoot: "/Users/example/LastCode & experiments",
    logDirectory: "/Users/example/.lastcode/automation",
    nodePath: "/Users/example/.local/share/mise/installs/node/24.13.1/bin/node",
    supervisorPath: "/Users/example/.lastcode/automation/bin/checkpoint supervisor.mjs",
  });

  expect(plist).toContain("<integer>1234</integer>");
  expect(plist).toContain("node/24.13.1/bin/node");
  expect(plist).toContain("checkpoint supervisor.mjs");
  expect(plist).not.toContain("/bin/zsh");
  expect(plist).not.toContain("/usr/bin/env");
  expect(plist).not.toContain("mise exec");
  expect(plist).not.toContain("git checkout");
  expect(plist).not.toContain("vp install");
  expect(plist).not.toContain("lastcode-build");
  expect(plist).toContain("LastCode &amp; experiments");
  expect(plist).toContain("nightly-checkpoint.stderr.log");
});

it("configures one durable recovery thread only during installation", () => {
  expect(
    parseNightlyServiceArgs([
      "install",
      "--interval-seconds",
      "1234",
      "--recovery-thread",
      "e01b7101-0713-4df7-9b6b-5c46f9d507db",
    ]),
  ).toEqual({
    command: "install",
    intervalSeconds: 1234,
    recoveryThreadId: "e01b7101-0713-4df7-9b6b-5c46f9d507db",
  });
  expect(
    parseNightlyServiceArgs(["install", "--interval-seconds", "1234", "--no-recovery-thread"]),
  ).toEqual({
    command: "install",
    clearRecoveryThread: true,
    intervalSeconds: 1234,
  });
  expect(() => parseNightlyServiceArgs(["run-now", "--recovery-thread", "thread-1"])).toThrow(
    "accepted only",
  );
  expect(() =>
    parseNightlyServiceArgs([
      "install",
      "--interval-seconds",
      "1234",
      "--recovery-thread",
      "short",
    ]),
  ).toThrow("valid thread ID");
  expect(() => parseNightlyServiceArgs(["install"])).toThrow("requires --interval-seconds");
  expect(() => parseNightlyServiceArgs(["install", "--interval-seconds", "not-a-number"])).toThrow(
    "positive integer",
  );
  expect(() =>
    parseNightlyServiceArgs([
      "install",
      "--interval-seconds",
      "1234",
      "--no-recovery-thread",
      "--recovery-thread",
      "thread-maintenance",
    ]),
  ).toThrow("either one recovery thread");
});

it("requests an idle service run without terminating an active checkpoint", () => {
  expect(parseNightlyServiceArgs(["run-now"])).toEqual({ command: "run-now" });
  expect(parseNightlyServiceArgs(["run-now", "--if-installed"])).toEqual({
    command: "run-now",
    ifInstalled: true,
  });
  expect(runNowArguments("gui/501/codes.lastobelus.lastcode-nightly-checkpoint")).toEqual([
    "kickstart",
    "gui/501/codes.lastobelus.lastcode-nightly-checkpoint",
  ]);
  expect(shouldRequestRunNow(false, false)).toBe(true);
  expect(shouldRequestRunNow(true, true)).toBe(true);
  expect(shouldRequestRunNow(true, false)).toBe(false);
  expect(shouldRunNightlyServiceCommand("run-now", true, "linux")).toBe(false);
  expect(() => shouldRunNightlyServiceCommand("run-now", false, "linux")).toThrow(
    "requires macOS launchd",
  );
  expect(() => shouldRunNightlyServiceCommand("status", false, "win32")).toThrow(
    "requires macOS launchd",
  );
});
