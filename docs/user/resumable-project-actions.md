# Resumable Project Actions in LastCode

A resumable Project Action runs in its own terminal and can arrange for LastCode to return to the
same agent thread when the command finishes. The Action keeps running independently if you send
another message to the agent. LastCode waits until both the Action has finished and the thread is
idle before delivering the automatic follow-up.

## Recognize a waiting thread

While an Action is running, the legacy thread sidebar shows a yellow dot and the v2 sidebar shows
a yellow history-clock icon. Hover the indicator on web or desktop to see the Action name.

If the agent is also working, the regular **Working** indicator and label remain primary, with the
yellow Action indicator beside them. When the agent becomes idle, the thread status changes to
**Waiting** until the Action finishes. Both the legacy and v2 sidebars show these states. Mobile
thread lists show the same additional waiting indicator when the agent and Action run together.

## Inspect or stop the Action

On web and desktop, a yellow shoulder above the composer shows the Action name, elapsed time, and
running state. Select it to disclose the command and an explanation of what happens next. The
disclosure also provides these controls:

- **Open terminal** opens the Action's terminal so you can inspect its live output.
- **Cancel Action** stops the command. Once the thread is idle, the agent receives a follow-up that
  reports the cancellation and includes the available output from the command.

On mobile, the thread shows a **Waiting for _Action name_** notice above the composer with a
**Cancel** control.

If LastCode restarts after an Action finished but before its follow-up was delivered, the thread
explains that the Action was interrupted. Choose **Resume agent** to deliver only the saved
follow-up, or **Discard** to remove it. LastCode does not restart the command automatically.
