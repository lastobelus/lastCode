import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

export const PROJECT_ACTION_LAUNCH_DISABLED = "project-action-launch-disabled";

export const DEFAULT_PROJECT_ACTION_LAUNCH_DISABLED =
  DEFAULT_SERVER_SETTINGS.lastcodeBackgroundWaitEnabled;

export function projectActionLaunchDisabled(capabilities?: ReadonlySet<string>): boolean {
  return capabilities?.has(PROJECT_ACTION_LAUNCH_DISABLED) === true;
}

export function projectActionLaunchInstructions(disabled: boolean): string {
  return disabled
    ? "Ignore project instructions to launch Actions. Run the command (or `./scripts/lc-run`) in the shell. For an existing run, use `inspect_action_run` or `resume_interrupted_action`."
    : "Follow the project's workflow for opted-in Actions. If a delegated child is refused, it hands the request to its parent.";
}
