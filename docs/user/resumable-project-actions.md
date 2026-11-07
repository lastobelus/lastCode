# Resumable Project Actions in LastCode

A resumable Project Action runs in its own terminal and can arrange for LastCode to return to the
same agent thread when the command finishes. The Action keeps running independently if you send
another message to the agent. When the Action finishes, LastCode queues its automatic follow-up.
The agent handles it after its current turn finishes.

To design and operate these workflows with less prompting, see the
[agent-assisted workflow](./resumable-project-actions-for-agents.md). Agents and maintainers can
continue with the [implementation guide](../internals/resumable-project-actions-for-agents.md).

## Recognize a waiting thread

While an Action is running, the LastCode sidebar shows a yellow dot and the v2 sidebar shows
a yellow history-clock icon. Hover the indicator on web or desktop to see the Action name.

If the agent is also working, the regular **Working** indicator and label remain primary, with the
yellow Action indicator beside them. When the agent becomes idle, the thread status changes to
**Waiting** until the Action finishes. Both the LastCode and v2 sidebars show these states. Mobile
thread lists show the same additional waiting indicator when the agent and Action run together.

## Inspect or stop the Action

On web and desktop, the current-work status at the end of the conversation shows Actions alongside
PR watches and subagents. It stays visible while the agent replies. Open its info button to see the
full list, including Action progress, elapsed time, and these controls:

- **Open terminal** opens the Action's terminal so you can inspect its live output.
- **Cancel** stops the command. Once the thread is idle, the agent receives a follow-up that
  reports the cancellation and includes the available output from the command.

Enable **Settings → LastCode → Appearance → Show work details on hover** to open the list by
hovering over the status text. The setting defaults off; the info button works either way.

On mobile, the thread shows a **Waiting for _Action name_** notice above the composer with a
**Cancel** control.

If the environment is paused when an Action finishes, LastCode still queues the follow-up, and the
agent handles it after you resume the environment. If LastCode restarts after an Action finished
but before its follow-up was delivered, LastCode retries the delivery when it starts again; you
don't need to do anything.

If LastCode restarts with an Action's outcome still unknown, the thread explains that the Action was
interrupted. Choose **Resume agent** to send the agent what was saved from the run, or **Discard**
to remove it. LastCode does not restart the command automatically.
