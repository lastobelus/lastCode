import { expect, it } from "vite-plus/test";

import {
  parseNightlyServiceArgs,
  renderLaunchAgentPlist,
  runNowArguments,
} from "./lastcode-nightly-service.ts";

it("renders an hourly source-only launch agent with escaped durable paths", () => {
  const plist = renderLaunchAgentPlist({
    home: "/Users/example",
    repoRoot: "/Users/example/LastCode & experiments",
    logDirectory: "/Users/example/.lastcode/automation",
    nodePath: "/Users/example/.local/share/mise/installs/node/24.13.1/bin/node",
    supervisorPath: "/Users/example/.lastcode/automation/bin/checkpoint supervisor.mjs",
  });

  expect(plist).toContain("<integer>3600</integer>");
  expect(plist).toContain("node/24.13.1/bin/node");
  expect(plist).toContain("checkpoint supervisor.mjs");
  expect(plist).toContain("<string>/usr/bin/env</string>");
  expect(plist).toContain("<string>-i</string>");
  expect(plist).not.toContain("/bin/zsh");
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
      "--recovery-thread",
      "e01b7101-0713-4df7-9b6b-5c46f9d507db",
    ]),
  ).toEqual({
    command: "install",
    recoveryThreadId: "e01b7101-0713-4df7-9b6b-5c46f9d507db",
  });
  expect(parseNightlyServiceArgs(["install"])).toEqual({ command: "install" });
  expect(() => parseNightlyServiceArgs(["run-now", "--recovery-thread", "thread-1"])).toThrow(
    "accepted only",
  );
  expect(() => parseNightlyServiceArgs(["install", "--recovery-thread", "short"])).toThrow(
    "valid thread ID",
  );
});

it("requests an idle service run without terminating an active checkpoint", () => {
  expect(runNowArguments("gui/501/codes.lastobelus.lastcode-nightly-checkpoint")).toEqual([
    "kickstart",
    "gui/501/codes.lastobelus.lastcode-nightly-checkpoint",
  ]);
});
