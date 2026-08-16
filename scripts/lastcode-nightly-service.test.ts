import { expect, it } from "vite-plus/test";

import { renderLaunchAgentPlist, runNowArguments } from "./lastcode-nightly-service.ts";

it("renders an hourly source-only launch agent with escaped durable paths", () => {
  const plist = renderLaunchAgentPlist({
    repoRoot: "/Users/example/LastCode & experiments",
    logDirectory: "/Users/example/.lastcode/automation",
  });

  expect(plist).toContain("<integer>3600</integer>");
  expect(plist).toContain("--push-tags --promote-if-no-open-prs --mirror-upstream-main");
  expect(plist).toContain("git checkout --detach --force refs/remotes/origin/lastcode/main");
  expect(plist).toContain("./node_modules/.bin/vp install --frozen-lockfile");
  expect(plist).not.toContain("lastcode-build");
  expect(plist).toContain("LastCode &amp; experiments");
  expect(plist).toContain("nightly-checkpoint.stderr.log");
});

it("requests an idle service run without terminating an active checkpoint", () => {
  expect(runNowArguments("gui/501/codes.lastobelus.lastcode-nightly-checkpoint")).toEqual([
    "kickstart",
    "gui/501/codes.lastobelus.lastcode-nightly-checkpoint",
  ]);
});
