import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const LASTCODE_CHECKPOINT_SERVICE_LABEL = "codes.lastobelus.lastcode-nightly-checkpoint";

const SCHEDULE_HELPER_FILE = "lastcode-checkpoint-schedule.mjs";
const SCHEDULE_REQUEST_FILE = "checkpoint-schedule-run-now.request";

export function checkpointServiceRunNowPaths(homeDirectory) {
  const automationDirectory = NodePath.join(homeDirectory, ".lastcode", "automation");
  return {
    plistPath: NodePath.join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LASTCODE_CHECKPOINT_SERVICE_LABEL}.plist`,
    ),
    requestPath: NodePath.join(automationDirectory, SCHEDULE_REQUEST_FILE),
  };
}

export function isDailyCheckpointLaunchAgent(plist) {
  return plist.includes(SCHEDULE_HELPER_FILE);
}

export function checkpointServiceRunNowArguments(service) {
  return ["kickstart", service];
}

function writeJsonAtomic(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Request a run from an installed checkpoint LaunchAgent without interrupting it.
 * `deferDaily` is reserved for automatic post-merge requests; an explicit
 * manual request must write the daily scheduler marker before kickstarting it.
 */
export function requestCheckpointServiceRunNow(options, overrides = {}) {
  const paths = checkpointServiceRunNowPaths(options.homeDirectory);
  const dependencies = {
    exists: NodeFS.existsSync,
    now: () => new Date(),
    readFile: (path) => NodeFS.readFileSync(path, "utf8"),
    runLaunchctl: (args) => {
      const result = NodeChildProcess.spawnSync("/bin/launchctl", args, { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`launchctl ${args.join(" ")} failed with ${result.status ?? "unknown"}.`);
      }
    },
    writeRequest: (path, value) => writeJsonAtomic(path, value),
    ...overrides,
  };

  if (!dependencies.exists(paths.plistPath)) return { status: "not-installed" };
  const daily = isDailyCheckpointLaunchAgent(dependencies.readFile(paths.plistPath));
  if (options.deferDaily && daily) return { status: "deferred" };
  if (daily) {
    dependencies.writeRequest(paths.requestPath, {
      requestedAt: dependencies.now().toISOString(),
    });
  }
  const service = `gui/${options.uid}/${LASTCODE_CHECKPOINT_SERVICE_LABEL}`;
  dependencies.runLaunchctl(checkpointServiceRunNowArguments(service));
  return { status: "requested" };
}
