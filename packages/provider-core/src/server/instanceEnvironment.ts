import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "./pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  localCiSettingsPath?: string,
): NodeJS.ProcessEnv {
  if ((!environment || environment.length === 0) && localCiSettingsPath === undefined) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  // Provider shells run CI for this server, including servers with a custom home.
  if (localCiSettingsPath !== undefined) {
    next.T3CODE_LOCAL_CI_SETTINGS_PATH = localCiSettingsPath;
  }
  return next;
}
