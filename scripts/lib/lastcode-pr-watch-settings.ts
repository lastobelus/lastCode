// @effect-diagnostics nodeBuiltinImport:off -- Host-side settings fragment reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_LASTCODE_PULL_REQUEST_WATCH_QUIET_MINUTES,
  LastCodePullRequestWatchQuietMinutes,
} from "../../packages/contracts/src/lastcodePullRequestWatchSettings.ts";
import * as Schema from "effect/Schema";

const decodeQuietMinutes = Schema.decodeUnknownSync(LastCodePullRequestWatchQuietMinutes);

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
  try {
    return decodeQuietMinutes(value);
  } catch {
    throw new Error(
      "Invalid PR watch settings: lastcodePullRequestWatchQuietMinutes must be an integer from 1 to 1440.",
    );
  }
}
