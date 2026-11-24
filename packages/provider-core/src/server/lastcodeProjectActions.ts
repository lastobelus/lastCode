export const PROJECT_ACTION_LAUNCH_DISABLED = "project-action-launch-disabled";

export function projectActionLaunchDisabled(capabilities?: ReadonlySet<string>): boolean {
  return capabilities?.has(PROJECT_ACTION_LAUNCH_DISABLED) === true;
}

const PROJECT_ACTION_LAUNCH_UNAVAILABLE =
  "Project Action launch tools are unavailable in this session.";

export const PROJECT_ACTION_ORCHESTRATION_INSTRUCTIONS = `- A delegated child owns its resumable Project Actions only when \`orchestrator_capabilities\` for its environment reports \`features.appOwnedActionContinuationVersion\` and LastCode issue #482 explicitly accepts that environment's installed checkpoint, or in an isolated acceptance scenario you were authorized to run. Say which in its brief. Its task then stays running across the Action wait, the runtime keeps you both from automatic settlement, and one final result arrives when it ends. A running task, a child turn that ended while waiting, or a waiting notice is not a handoff: end your turn and let completion wake you. Do not poll, read, schedule, relay, or launch for it.
- Otherwise a delegated child, including one whose launch was refused, must not launch or wait on a resumable Project Action, whatever else its brief says. It ends its turn with a final response that marks the work unfinished and asks its parent to run the exact Action. As the parent: requests already handed to you stay yours. Mediate each request in order:
  1. Receive it as the child's final response and recorded task result, through the async completion notification or a terminal \`delegate_task\` wait return. Never poll; a message from a still-running child is not yet a handoff. Keep one outstanding Action per parent thread and hold further requests in your handoff record.
  2. Verify the target. An eligible listing proves neither command nor target: check the saved command, its opt-in, cwd, environment, and worktree-local package or build selection against the child's checkout. If an isolated target cannot be prepared, use a shared checkout with serialized changes, or report the blocker. Never substitute your own default Action, run its command in a shell, or rebind yourself to the child's worktree.
  3. Launch the Action and end your turn.
  4. On its result, \`t3_thread_send\` to that child with \`mode: "queue"\` and a stable \`clientRequestId\`, never \`auto\` or \`steer\`. Claim tracking only once the receipt returns a \`taskId\`; report a missing one instead of resending.
- A thread's own eligible Actions and the Actions a parent launches through mediation need no automatic-settlement setting change, so ask for none. The runtime protects an unfinished or recoverable Action and its exact retained or queued follow-up from automatic settlement, and no further than that continuation. An explicit user lifecycle choice, such as Stop or Settle, stands.`;

export function projectActionOrchestrationSections(
  sections: ReadonlyArray<string>,
  disabled: boolean,
): ReadonlyArray<string> {
  return disabled
    ? sections.map((section) =>
        section === PROJECT_ACTION_ORCHESTRATION_INSTRUCTIONS
          ? PROJECT_ACTION_LAUNCH_UNAVAILABLE
          : section,
      )
    : sections;
}

export function projectActionHandoffInstructions(disabled: boolean): string {
  return disabled
    ? ""
    : `\n\nA delegated child owns resumable Project Actions only when its brief says the parent verified features.appOwnedActionContinuationVersion and installed acceptance, or authorized an isolated acceptance scenario. Then launch the eligible saved Action yourself and end your turn, saying the task is unfinished and what it waits on: the Action, or a Pause, pending input, or recovery that needs attention. Your task continues when the result arrives. Otherwise, or if the launch is refused, leave the Action to your parent, even when run_project_action_and_resume is available: end your turn with a final response that marks the work unfinished and requests the Action, giving your thread, project, environment, exact checkout and head SHA, the eligible Action, the result you expect, and your next step. That response is the handoff; send no separate parent message.`;
}
