// @effect-diagnostics nodeBuiltinImport:off -- Host-side settings fragment reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES,
  LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE,
} from "../../packages/contracts/src/lastcodePullRequestWatchQuietMinutes.ts";

const { minimum, maximum } = LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES_RANGE;

export async function readPullRequestWatchQuietMinutes(env = process.env) {
  const settingsPath =
    env.T3CODE_PR_WATCH_SETTINGS_PATH ??
    NodePath.join(
      env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".lastcode"),
      "userdata",
      "settings.json",
    );
  let content: string;
  try {
    content = await NodeFSP.readFile(settingsPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES;
    throw new Error("Unable to read PR watch settings. Check the settings file permissions.", {
      cause: error,
    });
  }
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    throw new Error("Invalid PR watch settings: the settings file must contain valid JSON.");
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings))
    throw new Error("Invalid PR watch settings: the settings file must contain an object.");
  const value = (settings as Record<string, unknown>).lastcodePullRequestWatchQuietMinutes;
  if (value === undefined) return DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES;
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum)
    return value;
  throw new Error(
    `Invalid PR watch settings: lastcodePullRequestWatchQuietMinutes must be an integer from ${minimum} to ${maximum}.`,
  );
}
