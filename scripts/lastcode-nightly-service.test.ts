// @effect-diagnostics nodeBuiltinImport:off -- This filesystem test verifies removal of durable launchd service state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  checkpointScheduleFromConfig,
  clearNightlyServiceState,
  isDailyLaunchAgent,
  nextCheckpointScheduleConfig,
  nextCheckpointSupervisorConfig,
  parseNightlyServiceArgs,
  renderLaunchAgentPlist,
  runNowArguments,
  shouldRequestRunNow,
  shouldDeferAutomaticRunNow,
  shouldRunNightlyServiceCommand,
} from "./lastcode-nightly-service.ts";

it("clears stale supervisor state when the service is removed", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-service-state-"));
  const statePath = NodePath.join(directory, "checkpoint-service-state.json");
  NodeFS.writeFileSync(statePath, '{"schemaVersion":1,"status":"failed"}\n');

  clearNightlyServiceState(directory);

  expect(NodeFS.existsSync(statePath)).toBe(false);
  NodeFS.rmSync(directory, { recursive: true });
});

it.each([
  { kind: "interval", intervalSeconds: 1234 },
  { kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" },
] as const)("uses standard process policy for $kind checkpoints", (schedule) => {
  const plist = renderLaunchAgentPlist({
    repoRoot: "/repo",
    logDirectory: "/home/example/.lastcode/automation",
    nodePath: "/node",
    schedule,
    scheduleHelperPath: "/home/example/.lastcode/automation/bin/lastcode-checkpoint-schedule.mjs",
    supervisorPath: "/home/example/.lastcode/automation/bin/lastcode-checkpoint-supervisor.mjs",
  });

  expect(plist).toContain("<key>ProcessType</key>\n  <string>Standard</string>");
});

it("renders the deployment-defined interval in a source-only launch agent", () => {
  const plist = renderLaunchAgentPlist({
    repoRoot: "/Users/example/LastCode & experiments",
    logDirectory: "/Users/example/.lastcode/automation",
    nodePath: "/Users/example/.local/share/mise/installs/node/26.12.1/bin/node",
    schedule: { kind: "interval", intervalSeconds: 1234 },
    scheduleHelperPath: "/Users/example/.lastcode/automation/bin/schedule helper.mjs",
    supervisorPath: "/Users/example/.lastcode/automation/bin/checkpoint supervisor.mjs",
  });

  expect(plist).toContain("<integer>1234</integer>");
  expect(plist).toContain("node/26.12.1/bin/node");
  expect(plist).toContain("checkpoint supervisor.mjs");
  expect(plist).not.toContain("/bin/zsh");
  expect(plist).not.toContain("/usr/bin/env");
  expect(plist).not.toContain("mise exec");
  expect(plist).not.toContain("git checkout");
  expect(plist).not.toContain("vp install");
  expect(plist).not.toContain("lastcode-build");
  expect(plist).toContain("LastCode &amp; experiments");
  expect(plist).toContain("nightly-checkpoint.stderr.log");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(isDailyLaunchAgent(plist)).toBe(false);
});

it("renders a time-zone-aware daily gate without a launchd calendar or immediate run", () => {
  const plist = renderLaunchAgentPlist({
    repoRoot: "/repo",
    logDirectory: "/home/example/.lastcode/automation",
    nodePath: "/node",
    schedule: { kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" },
    scheduleHelperPath: "/home/example/.lastcode/automation/bin/lastcode-checkpoint-schedule.mjs",
    supervisorPath: "/home/example/.lastcode/automation/bin/lastcode-checkpoint-supervisor.mjs",
  });

  expect(plist).toContain("<integer>60</integer>");
  expect(plist).toContain("<string>02:00</string>");
  expect(plist).toContain("<string>America/Los_Angeles</string>");
  expect(plist).not.toContain("StartCalendarInterval");
  expect(plist).not.toContain("RunAtLoad");
  expect(isDailyLaunchAgent(plist)).toBe(true);
  expect(shouldDeferAutomaticRunNow(true, plist)).toBe(true);
  expect(shouldDeferAutomaticRunNow(false, plist)).toBe(false);
});

it.each([
  { kind: "interval", intervalSeconds: 1234 },
  { kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" },
] as const)(
  "wraps the whole $kind command while retaining the installed Node executable",
  (schedule) => {
    const launcherPrefix = ["/usr/bin/env", "TEST_LABEL=a & <b> \"c\" 'd'"];
    for (const nodePath of ["/opt/runtime-a/bin/node", "/opt/runtime-b/bin/node"]) {
      const plist = renderLaunchAgentPlist({
        repoRoot: "/repo",
        logDirectory: "/logs",
        nodePath,
        launcherPrefix,
        schedule,
        scheduleHelperPath: "/helpers/lastcode-checkpoint-schedule.mjs",
        supervisorPath: "/helpers/supervisor.mjs",
      });
      const command =
        schedule.kind === "interval"
          ? ["/helpers/supervisor.mjs", "run"]
          : [
              "/helpers/lastcode-checkpoint-schedule.mjs",
              "run",
              "--daily-at",
              "02:00",
              "--time-zone",
              "America/Los_Angeles",
            ];
      expect(plist).toContain(
        [
          "<key>ProgramArguments</key>\n  <array>",
          "<string>/usr/bin/env</string>",
          "<string>TEST_LABEL=a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;</string>",
          `<string>${nodePath}</string>`,
          ...command.map((argument) => `<string>${argument}</string>`),
        ].join("\n    ") + "\n  </array>",
      );
      expect(isDailyLaunchAgent(plist)).toBe(schedule.kind === "daily");
    }
  },
);

it.each(["install", "configure-schedule"])(
  "accepts explicit launcher changes for %s",
  (command) => {
    expect(
      parseNightlyServiceArgs([
        command,
        "--launcher-prefix-json",
        '["/usr/bin/env","TEST_MODE=1"]',
      ]),
    ).toEqual({
      command,
      launcherPrefix: ["/usr/bin/env", "TEST_MODE=1"],
      trustedProjectActionIds: [],
    });
    expect(parseNightlyServiceArgs([command, "--clear-launcher-prefix"])).toEqual({
      command,
      clearLauncherPrefix: true,
      trustedProjectActionIds: [],
    });
    expect(() => parseNightlyServiceArgs([command, "--launcher-prefix-json"])).toThrow(
      "valid JSON",
    );
    expect(() =>
      parseNightlyServiceArgs([
        command,
        "--launcher-prefix-json",
        '["/usr/bin/env"]',
        "--clear-launcher-prefix",
      ]),
    ).toThrow("either");
    expect(() =>
      parseNightlyServiceArgs([
        command,
        "--clear-launcher-prefix",
        "--launcher-prefix-json",
        '["/usr/bin/env"]',
      ]),
    ).toThrow("either");
    expect(() =>
      parseNightlyServiceArgs([
        command,
        "--launcher-prefix-json",
        '["/usr/bin/env"]',
        "--launcher-prefix-json",
        '["/usr/bin/env"]',
      ]),
    ).toThrow("either");
    expect(() =>
      parseNightlyServiceArgs([command, "--clear-launcher-prefix", "--clear-launcher-prefix"]),
    ).toThrow("either");
  },
);

it.each([
  "not-json",
  "[]",
  "null",
  "{}",
  '["env"]',
  '[""]',
  "[42]",
  '["/usr/bin/env",42]',
  '["/usr/bin/env",null]',
  '["/usr/bin/env","\\u0000"]',
])("rejects an invalid launcher prefix: %s", (json) => {
  expect(() => parseNightlyServiceArgs(["install", "--launcher-prefix-json", json])).toThrow(
    /requires valid JSON|launcherPrefix must be/u,
  );
});

it("retains, replaces and clears the launcher prefix across schedule and install refreshes", () => {
  const interval = { kind: "interval", intervalSeconds: 1234 } as const;
  const daily = { kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" } as const;
  const launcherPrefix = ["/usr/bin/env", "TEST_MODE=1", ""];
  const current = { schemaVersion: 1, schedule: interval, launcherPrefix };
  expect(nextCheckpointScheduleConfig(undefined, current)).toEqual(current);
  const changedSchedule = nextCheckpointScheduleConfig(daily, current);
  expect(changedSchedule).toEqual({ ...current, schedule: daily });
  expect(nextCheckpointScheduleConfig(undefined, changedSchedule)).toEqual(changedSchedule);
  expect(
    nextCheckpointScheduleConfig(undefined, current, { launcherPrefix: ["/usr/bin/env"] }),
  ).toEqual({ ...current, launcherPrefix: ["/usr/bin/env"] });
  const cleared = nextCheckpointScheduleConfig(undefined, current, { clearLauncherPrefix: true });
  expect(cleared).toEqual({ schemaVersion: 1, schedule: interval });
  expect(nextCheckpointScheduleConfig(undefined, cleared)).toEqual(cleared);
  expect(nextCheckpointScheduleConfig(interval, null)).toEqual(cleared);
});

it.each(
  [null, [], "invalid", ["env"], ["/usr/bin/env", 42]].map((launcherPrefix) => ({
    launcherPrefix,
  })),
)(
  "does not silently drop an invalid persisted launcher prefix: $launcherPrefix",
  ({ launcherPrefix }) => {
    const schedule = { kind: "interval", intervalSeconds: 1234 } as const;
    const current = { schemaVersion: 1, schedule, launcherPrefix };
    expect(() => nextCheckpointScheduleConfig(undefined, current)).toThrow("launcherPrefix");
    expect(() => nextCheckpointScheduleConfig(schedule, current)).toThrow("launcherPrefix");
    expect(nextCheckpointScheduleConfig(undefined, current, { clearLauncherPrefix: true })).toEqual(
      { schemaVersion: 1, schedule },
    );
    expect(
      nextCheckpointScheduleConfig(undefined, current, { launcherPrefix: ["/usr/bin/env"] }),
    ).toEqual({ schemaVersion: 1, schedule, launcherPrefix: ["/usr/bin/env"] });
  },
);

it("configures one durable recovery thread only during installation", () => {
  expect(
    parseNightlyServiceArgs([
      "install",
      "--interval-seconds",
      "1234",
      "--recovery-thread",
      "e01b7101-0713-4df7-9b6b-5c46f9d507db",
      "--trusted-project-action",
      "lc-wait-for-checkpoint",
    ]),
  ).toEqual({
    command: "install",
    intervalSeconds: 1234,
    recoveryThreadId: "e01b7101-0713-4df7-9b6b-5c46f9d507db",
    trustedProjectActionIds: ["lc-wait-for-checkpoint"],
  });
  expect(
    parseNightlyServiceArgs(["install", "--interval-seconds", "1234", "--no-recovery-thread"]),
  ).toEqual({
    command: "install",
    clearRecoveryThread: true,
    intervalSeconds: 1234,
    trustedProjectActionIds: [],
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
  expect(parseNightlyServiceArgs(["install"])).toEqual({
    command: "install",
    trustedProjectActionIds: [],
  });
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

it("configures interval or time-zone-aware daily schedules independently of installation", () => {
  expect(
    parseNightlyServiceArgs([
      "configure-schedule",
      "--daily-at",
      "02:00",
      "--time-zone",
      "America/Los_Angeles",
    ]),
  ).toEqual({
    command: "configure-schedule",
    dailyAt: "02:00",
    timeZone: "America/Los_Angeles",
    trustedProjectActionIds: [],
  });
  expect(parseNightlyServiceArgs(["configure-schedule", "--interval-seconds", "3600"])).toEqual({
    command: "configure-schedule",
    intervalSeconds: 3600,
    trustedProjectActionIds: [],
  });
  expect(() =>
    parseNightlyServiceArgs([
      "configure-schedule",
      "--daily-at",
      "24:00",
      "--time-zone",
      "America/Los_Angeles",
    ]),
  ).toThrow("24-hour HH:MM");
  expect(() =>
    parseNightlyServiceArgs([
      "configure-schedule",
      "--daily-at",
      "02:00",
      "--time-zone",
      "Not/A_Zone",
    ]),
  ).toThrow("IANA time zone");
  expect(() =>
    parseNightlyServiceArgs([
      "configure-schedule",
      "--interval-seconds",
      "3600",
      "--daily-at",
      "02:00",
      "--time-zone",
      "America/Los_Angeles",
    ]),
  ).toThrow("either an interval");
  expect(() => parseNightlyServiceArgs(["configure-schedule", "--daily-at", "02:00"])).toThrow(
    "requires both",
  );
  expect(() => parseNightlyServiceArgs(["configure-schedule"])).toThrow(
    "requires an interval or daily schedule",
  );
});

it("validates the persisted schedule read during installation", () => {
  expect(
    checkpointScheduleFromConfig({
      schemaVersion: 1,
      schedule: { kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" },
    }),
  ).toEqual({ kind: "daily", dailyAt: "02:00", timeZone: "America/Los_Angeles" });
  expect(
    checkpointScheduleFromConfig({
      schemaVersion: 1,
      schedule: { kind: "interval", intervalSeconds: 3600 },
    }),
  ).toEqual({ kind: "interval", intervalSeconds: 3600 });
  expect(() => checkpointScheduleFromConfig(null)).toThrow("configure-schedule first");
  expect(() =>
    checkpointScheduleFromConfig({
      schedule: { kind: "daily", dailyAt: "02:00", timeZone: "Not/A_Zone" },
    }),
  ).toThrow("invalid IANA time zone");
});

it("persists the Project Action trust allowlist without discarding recovery delivery", () => {
  expect(
    nextCheckpointSupervisorConfig(
      { schemaVersion: 1, recoveryThreadId: "thread-maintenance" },
      { trustedProjectActionIds: ["lc-wait-for-checkpoint"] },
    ),
  ).toEqual({
    schemaVersion: 1,
    recoveryThreadId: "thread-maintenance",
    trustedProjectActionIds: ["lc-wait-for-checkpoint"],
  });
  expect(
    nextCheckpointSupervisorConfig(
      {
        schemaVersion: 1,
        recoveryThreadId: "thread-maintenance",
        trustedProjectActionIds: ["lc-wait-for-checkpoint"],
      },
      { clearRecoveryThread: true, trustedProjectActionIds: [] },
    ),
  ).toEqual({ schemaVersion: 1, trustedProjectActionIds: [] });
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
