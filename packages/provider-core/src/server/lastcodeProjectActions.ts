export const PROJECT_ACTION_LAUNCH_DISABLED = "project-action-launch-disabled";

export function projectActionLaunchDisabled(capabilities?: ReadonlySet<string>): boolean {
  return capabilities?.has(PROJECT_ACTION_LAUNCH_DISABLED) === true;
}

export function projectActionLaunchInstructions(disabled: boolean): string {
  return disabled
    ? "Project Action launch tools are unavailable in this session."
    : "Project Action launch tools require a saved Action opted in for agent use. Follow the project's workflow.";
}
