# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a pinned or active thread's menu and choose **Move up** or **Move down**. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

## Questions from agents

Agents can mark a thread when their latest response contains a question that blocks further work.
The sidebar shows a violet `?`, or **Question** when long status labels are enabled, so the thread
does not get lost among other conversations. Sending a reply clears the marker automatically.
Settling the thread yourself also dismisses it; automatic settlement waits until the question has
been answered or cleared.

This marker is separate from a provider's structured approval and input prompts. Those keep their
existing, higher-priority status. The agent can currently raise only the `question` attention kind;
the stored attention record is typed so future user-actionable kinds can be added without treating
terminal output as an API.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Thread annotations in LastCode

A thread can have one Markdown annotation for notes, headings, lists, task lists, and tags. In the
legacy sidebar, open a thread's context menu and choose **Annotate thread…**. An active annotation
adds a short dotted yellow underline to the thread timestamp; hover it to read, edit, or resolve
the note without opening the thread.

Opening an annotated thread shows a compact yellow note above the composer, with its first line
and edit timestamp. Expand it to read the full Markdown; your expanded or collapsed choice is
remembered for that thread across navigation and reloads. Choose **Edit** to open the existing
Markdown in the editor. You can dismiss the note for the current visit without deleting or resolving it. The
conversation minimap marks the message that was newest when the annotation was created or last
changed. Editing, resolving, or reopening the annotation moves that marker to the newest message.
Resolved annotations disappear from the sidebar and composer but remain available from their
yellow minimap marker, where they can be edited or reopened.

## Resumable Project Actions in LastCode

Threads with a running resumable Project Action keep a yellow waiting indicator beside any active
**Working** status. When the agent becomes idle, the primary status changes to **Waiting**. Hover
the indicator on web or desktop to see the Action name. See
[Resumable Project Actions in LastCode](./resumable-project-actions.md) for the automatic follow-up
behavior and the composer controls.

## Worktree cleanup in LastCode

When you delete a thread and choose to delete its worktree, the thread stays in the sidebar until
the server finishes that cleanup. **Deleting** means removal is active. **Deleting (Queued)** means
another worktree from the same repository is being removed first; hover the row to see which
thread it is waiting for. Cleanup for different repositories can proceed at the same time.

If cleanup fails, the row changes to **Cleanup failed**. Select anywhere on that row to see the
error and choose **Retry**, **Copy details**, or **Keep worktree**. LastCode resumes unfinished
cleanup after a server restart. On mobile, long-press a failed row to choose **Retry** or
**Keep worktree**.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Legacy sidebar scale in LastCode

When the legacy sidebar is enabled, LastCode can make its project and thread rows more compact.
Open **Settings → LastCode → Appearance** and adjust **Scale legacy sidebar** from 50% through 100%. The 75%
mark is labeled as a useful compact reference point. The default is 100%, and your selection is
stored locally and retained when LastCode restarts.

This setting compacts project headings and thread rows while keeping project favicons, action or
status icons, remote cloud indicators, and relative timestamps at their standard size. The
LastCode header, Search field, Projects heading, drafts, status notices, and footer also stay at
their standard size. On desktop, **View → Actual Size**, **Zoom In**, and **Zoom Out** continue to
zoom the whole application and compose with the legacy sidebar scale.
To keep the same status colors while using less horizontal space, enable **Compact status
indicators** in **Settings → LastCode → Appearance**. Legacy thread rows then show only the
colored status dot; the full status remains available as a tooltip. This preference is off by
default.

To hide the worktree icon beside threads that use a dedicated worktree, turn off **Show worktree
indicators** in **Settings -> LastCode -> Appearance**. The icon remains visible by default.

## Environment icons in LastCode

Open **Settings → LastCode → Environments** to choose the icon color for the primary machine and
each saved remote environment. **Default** preserves the semantic icon treatment for each surface;
a custom color is shown at full strength in sidebar rows, project headings, and thread details. The
icon beside each environment name previews the selection.

Remote environments use a Server icon. The primary machine uses a Laptop icon, which can be shown
or hidden in thread cards and legacy thread rows with **Show local icon**. Legacy rows reserve the
same icon space either way so their columns stay aligned. Mixed legacy project groups always show
one icon for every environment in the group, including the primary machine, with duplicate
environments collapsed to one icon.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
