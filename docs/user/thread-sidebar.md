# Working with threads

Use a separate thread for each task. Choose **New worktree** when a task needs its own Git branch and working directory; threads sharing a checkout share its branch, so T3 Code blocks branch switches while one is running.

## Pause before going offline

Enable **Environment pause button** in **Settings → LastCode** for each environment
where you want it. It is off by default. The sidebar button pauses only the
environment running on this computer. To pause a remote environment, or to pause
from mobile, use its control in **Settings → Connections**. Each control shows
that environment's own pause state.

Click **Pause** once. Each active thread receives an ordinary “pause to go
offline” message. Automatic thread wake-ups are held until you resume, even if
you reconnect or restart. PR watches stop polling while paused. Scheduled tasks
follow their usual missed-run policy when you return.

The environment is quiet once its agents stop and its real background work ends:
background commands, Project Actions and cleanup still count as unfinished.
Browser previews keep running and don't need to stop before you move your laptop.
Progress is shown while threads stop, but you don't need to watch it.

The button turns into **Resume** (play) as soon as you pause. Click it at any
moment, even while threads are still pausing. It sends “resume” only to threads
that received Pause, and cancels pause messages that haven't been delivered yet.

If a pause or resume message can't be delivered, the thread stays listed with
the error. Open **Manage pause** and choose **Retry pause** or **Resume** for the
failed message. Archived or deleted threads don't receive Resume.

## Start a thread

- **Web and desktop**: **New thread** opens the project picker when you have multiple open projects (unless the sidebar is filtered to one project). `Shift`-click to start in the current project. To reuse an existing worktree, choose **New thread in this worktree** from the branch toolbar.
- **Mobile**: **New thread** uses the current, filtered, or last-opened project. Disable **Settings → General → Use last project** to pick every time.
- **Defaults**: New threads inherit your last model and mode unless the project sets its own model default.

### Start without a project

Threads don't require a project. Pick **No project** (or press `mod+alt+n` on web/desktop) to start a scratch thread in `~/.t3/scratch/<date>-<slug>-<id>`.

- Deleting a thread initially keeps its folder. When the inactivity rule in
  [automatic worktree cleanup](./project-settings.md#permanent-deletion-and-generated-files)
  is enabled, a scratch folder is saved and removed after every thread using it is archived
  or deleted and the inactivity delay has passed. You can restore it from Saved workspaces
  in Settings.
- Git branch, worktree, and diff controls are hidden (and scratch threads are unavailable if your T3 data directory itself is inside a Git repo).
- Choose **Turn into project** from the thread menu to promote the folder into a real project in place, then **Initialize Git** if needed.

### Start in the background and multi-model runs

- **Background start** (web/desktop): Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) in a new thread to submit it and immediately open another draft with the same workspace mode and base branch.
- **Same prompt, multiple models** (web/desktop, Git projects): `Shift`-click models in a new thread's model picker to select several. Sending starts a separate thread and worktree for each model.

## Sidebar layout and organization

- **Resize or hide** (web/desktop): Drag the sidebar's right edge past its minimum width to hide it; hover the left window edge and click or drag the handle to bring it back.
- **Drop files onto a thread** (web/desktop): Drag files from your computer onto any thread row to open it and attach them to its composer.
- **Pin and reorder**: Pin a thread from its menu or drag threads between **Pinned**, **Active**, and **Settled** (or drag out of **Snoozed** to wake). On mobile, use **Arrange threads** or **Move up / Move down** in the thread menu. Custom order syncs across devices (requires an up-to-date server).
- **Undo** (web/desktop): Unpinning, settling, snoozing, archiving, or discarding a draft shows a 5-second **Undo** toast (`mod+z`).
- **Titles**: Choose **Regenerate title** from a thread's menu, or customize title style in **Settings → Threads → Text generation → Thread title instructions** (global or per-project).

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

### Organize related threads

Ask an agent to create a group thread and move existing conversations under it.
Parents can nest to any depth, and moving a parent brings its children along. A thread
and its parent must be in the same project and environment.

Organizing changes only where a thread sits. It doesn't change the thread's owner,
stop or move running work, or change who receives a delegated task's result. A delegated
child that its task still owns can't move until it is released. To see a group, ask the
agent to list a parent's children. To undo a move, ask it to restore the previous placement.

### Working section (beta)

Enabled by default (**Settings → General → Working section**, per device). Unpinned threads that are actively running—or waiting on subagents, watched PRs, or monitors—collapse into a **Working** section below Active, and return to the top of Active when they finish, fail, or need input.

While enabled, Active is sorted by most recent return (manual reordering is paused until you turn it off).

### Group threads by project (beta)

Enable **Settings → Labs → Boring sidebar (group by project)** on web/desktop (per device) to group active threads into collapsible project folders. Pinned threads stay above; Snoozed and Settled stay below. In this mode, the Working section and sidebar drag-reordering are disabled (dragging a thread onto the composer still works).

## Read and unread replies

On web and desktop, use **Mark unread** in a thread's menu to return to a completed reply
later. **Mark read** acknowledges it without sending a message. Both actions also work on a
selection; threads with no completed reply cannot be marked unread.

## Choose the LastCode sidebar

On web and desktop, enable **Settings → LastCode → Appearance → LastCode sidebar**
for the LastCode project tree, annotations, and family controls. It is off by default.
While enabled, use the tree button or the **Sidebar: Toggle Presentation** shortcut to switch
between LastCode and the v2 sidebar for this session without changing the setting.
With LastCode off, the same control turns the setting on. Turn the setting off to return to the v2 sidebar.

**Family status subheaders**, in the same Appearance settings, is on by default. Turn it off
to show the family status and child count in the parent row while keeping the child tree.

## Thread annotations in LastCode

A thread has one current Markdown annotation at a time, for notes, headings, lists, task lists, and
tags. In the LastCode sidebar, open a thread's context menu and choose **Annotate thread…**. Once a
note is current, the menu offers **Edit Annotation…** and **Resolve Annotation…** instead. The
current annotation adds a short dotted yellow underline to the thread timestamp; hover it to read,
edit, or resolve the note without opening the thread.

Opening an annotated thread shows a compact yellow note above the composer, with its first line
and edit timestamp. Expand it to read the full Markdown; your expanded or collapsed choice is
remembered for that thread across navigation and reloads. Choose **Edit** to open the existing
Markdown in the editor. You can dismiss the note for the current visit without deleting or resolving it.

The conversation minimap has a yellow marker for each annotation: solid for the current note, faded
for resolved notes. An annotation needs a user message to anchor it. A new note starts at the newest
user message, and resolving it moves the marker to the latest user message. Editing or reopening
keeps the anchor in place.

Resolved annotations disappear from the sidebar and composer but keep their minimap markers. Choose
**Annotate thread…** to start a new note; your resolved notes stay as they are. Hover a resolved
note's marker to edit it or reopen it. Only one note can be current, so to reopen an older note,
resolve the current one first or copy what you need into it.

Use **Hide thread until** in the annotation editor to put a thread aside until newer LastCode
checkpoints are installed, another thread is archived, a pull request is merged, or a date and time
in your local time zone arrives. Threads it owns hide with it. You can leave the note empty when
you add a trigger. An open thread stays visible while you view it, and a thread that needs your
answer or approval stays visible until you respond. You can also find hidden threads through a
direct link or by searching for their titles in the command palette.

Choose **Show now** on the annotation to bring the thread back early, or resolve the annotation to
clear the trigger. A revealed thread comes back unread and the annotation records why it returned.
Deleting the target thread or closing the target PR also brings the thread back with an explanation.

**Settings → LastCode → PR checks for hidden threads** controls how often the environment checks PR
triggers. The default is 15 minutes. Pausing the environment pauses PR checks. Date, archive, and
checkpoint triggers keep running.

## Resumable Project Actions in LastCode

Threads with an in-flight resumable Project Action keep a yellow waiting indicator beside any active
**Working** status. When the agent becomes idle, the primary status changes to **Waiting**. Hover
the indicator on web or desktop to see the Action name. See
[Resumable Project Actions in LastCode](./resumable-project-actions.md) for the automatic follow-up
behavior and the composer controls. Agents normally use
[background waits for long commands](./resumable-project-actions-for-agents.md).

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

## LastCode sidebar scale

When the LastCode sidebar is enabled, LastCode can make its project and thread rows more compact.
Open **Settings → LastCode → Appearance** and adjust **Scale LastCode sidebar** from 50% through 100%. The 75%
mark is labeled as a useful compact reference point. The default is 100%, and your selection is
stored locally and retained when LastCode restarts.

This setting compacts project headings and thread rows while keeping project favicons, action or
status icons, remote cloud indicators, and relative timestamps at their standard size. The
LastCode header, Search field, Projects heading, drafts, status notices, and footer also stay at
their standard size. On desktop, **View → Actual Size**, **Zoom In**, and **Zoom Out** continue to
zoom the whole application and compose with the LastCode sidebar scale.
To keep the same status colors while using less horizontal space, enable **Compact status
indicators** in **Settings → LastCode → Appearance**. LastCode thread rows then show only the
colored status icon; the full status remains available as a tooltip. This preference is off by
default.

Use **Status icons** in the same settings section to choose a circle, square, diamond, triangle,
or right-pointing triangle for each agent status. Each shape supports an outline, a solid fill,
or an outline with a 50% fill. Colors and status meanings stay the same. New statuses use a solid
circle until you choose another icon; resetting Status icons restores solid circles for all statuses.

To hide the worktree icon beside threads that use a dedicated worktree, turn off **Show worktree
indicators** in **Settings -> LastCode -> Appearance**. The icon remains visible by default.

## Environment icons in LastCode

Open **Settings → LastCode → Environments** to choose the icon color for the primary machine and
each saved remote environment. **Default** preserves the semantic icon treatment for each surface;
a custom color is shown at full strength in sidebar rows, project headings, and thread details. The
icon beside each environment name previews the selection.

Remote environments use a Server icon. The primary machine uses a Laptop icon, which can be shown
or hidden in thread cards and LastCode thread rows with **Show local icon**. LastCode rows reserve the
same icon space either way so their columns stay aligned. Mixed LastCode project groups always show
one icon for every environment in the group, including the primary machine, with duplicate
environments collapsed to one icon.

## Settle, snooze, and archive

| Action      | When to use          | Effect                                                                                                                                         |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settle**  | Task is done for now | Moves to **Settled**; stays searchable; any new message reactivates it. Closes idle terminals (and stops actions with `stopOnSettle: true`).   |
| **Snooze**  | Defer until later    | Hides until wake time (thread keeps working in the background). Wakes early on approvals, questions, errors, or new messages.                  |
| **Archive** | Out of the way       | Leaves sidebar and search; lives in **Settings → Archive**. Refuses new messages (including from agents and scheduled tasks) until unarchived. |

> Tip: If a scheduled task targets a thread, settle it instead of archiving—archiving causes scheduled runs to fail.

### Settlement rules and hooks

- **Automatic settlement**: By default, environments settle threads after 7 days of inactivity or when their linked PR merges/closes (even while your apps are closed). Active work, pending questions/approvals, and waited-on background work block auto-settlement. Configure rules in **Settings → Threads** (per environment or **All environments**), including **Keep threads with a PR**.
- **Per-thread override**: Open a thread's menu → **Auto-settle behavior → Never** to exempt a single thread.
- **Drag-to-settle** (web/desktop): Press and drag down/up from a thread's **Settle**, **Un-settle**, or **Wake** button to act on a contiguous range (`Esc` cancels).
- **Offline settle/snooze**: Queues locally (**Pending** / **Waiting to sync**) and syncs on reconnect; remote changes take precedence if the thread changed in the meantime.
- **Worktree cleanup on settle**: Enable **Run in the thread's worktree when the thread settles** on a project action (or `"runOnSettle": true` in `t3.json`), e.g. `cargo clean`, to reclaim disk space automatically in worktree threads.

### Archive and restore a thread family

Archiving includes grouped threads, subagents, and owned work in other projects on
the same machine.
If any family member is working or has unread replies, a confirmation lists it.
Owned conversations you've typed in, and what they own, stay open unless you include
them. The confirmation lists work on each directly linked machine. A machine that is
offline, refuses access, or needs an update stays listed while the local archive finishes.
Open **Linked archive status** in **Archived threads** to retry. Review the
machine's conversations if they were unavailable or changed after your review.
When more than one operation is listed, choose by its archive date.
**Stop active threads & archive** stops unfinished work, cancels pending approvals
and queued messages, and archives the family. **Archive unread threads** preserves
replies in archived history. Cancel to inspect children or make eligible threads
independent before archiving again. Forks and independent threads stay separate.

If work appears stuck, **Ask the agent** can ask the agent responsible for it whether
it is finished. The question opens in that agent's conversation; review the answer,
then try archiving again. Busy agents can be reviewed directly instead. Asking
does not archive the family or authorize stopping unrelated work.

Persistent children must be made independent or have their protection removed
before the family can be archived. If stopping fails, the family remains visible;
some work may already have stopped. Undo or restoring the archived family brings
its conversations back without restarting work. Promoted conversations remain
independent.

Restoring a thread restores the conversations archived with it, without restarting
stopped work. If some linked machines could not restore their conversations, use
**Linked archive status** in the restored thread's menu to retry. Older pending
restores stay listed even if you archive the thread again. Restore the parent
before restoring its archived children. Deleting the parent deletes its subagents too.

### Snooze options

Customize presets in **Settings → Threads → Snooze options** (durations like `3 hours` or times like `9:00 PM tomorrow`), or pick **Snooze → Custom…** for an exact date/time or duration. Choose **Wake thread** to bring a thread back early.

## Link a pull request

The server automatically links open PRs matching an unsettled thread's branch. On web/desktop, right-click any PR link in a thread and choose **Link to thread** or **Unlink from thread** to override it. Linked PRs participate in auto-settlement.

## Find and reference work

- **Command palette** (`Cmd/Ctrl+K`): Searches threads across connected environments by title, branch, PR, project, and message contents (use `"exact phrase"` for exact matches). On mobile, use the thread list search (or `Cmd+K` on iPad with a keyboard).
- **Copy reference**: Copies the linked PR URL if one exists, otherwise a thread link that pastes into any composer as a thread chip. Use **Copy → Thread** (or **Copy thread** on mobile) to force a thread link, or **Thread ID** for scripts and the `t3` CLI.

## Usage limits, subagents, and thread details

- **Usage limits**: When a provider hits a rate/usage limit (**Limited**), press **Resume** in an empty composer after reset (or send a message). If the provider reports a reset time, choose **Resume at reset** or **Snooze until reset**—or enable defaults in **Settings → Threads** (**Resume after usage limits** / **Snooze until limits reset**).
- **Subagents**: Follow delegated work from the conversation card or **Agents**. Stopping a parent thread also stops its delegated subagents. Provider-native subagents can't take messages; message the parent thread instead.
- **Running dev servers** (web/desktop): The thread details card lists local servers started by the thread's terminals or Claude agent with their ports. Click one to open it in the browser panel, or **Stop** to end it (macOS/Linux only).
- **Customize thread details**: Right-click the thread details card or open **Settings → Appearance → Thread details** to show/hide rows.

### Ownership of agent-created threads

A thread an agent starts belongs to the thread that started it, unless you ask for
a top-level thread. By default, owned threads appear under their owner in the same
project, even across connected machines, or in a collapsed group named after their
owner in another project.

To keep an owned thread as a top-level conversation, choose **Promote** from its
sidebar menu. A launched child can be promoted while it runs. If a delegated task
still owes its result or is waiting on a PR watch or Action, wait for it to finish
or cancel it first. Choose **Return to owner** to restore its original owner and
default placement. If the owner is on another machine, the menu tells you its
state there wasn't checked.

## Open a thread beside the one you are in

On web and desktop, subagents, side chats, and [threads on linked machines](./remote-access.md#read-a-linked-machines-threads) open as a tab in the right panel by default so your main thread stays visible.

- Hold `Cmd`/`Ctrl` while clicking (or middle-click) to open in the main view instead.
- Change the default in **Settings → Chat → Open subagents and side chats in**.
- From a right-panel tab, choose **Open in main view** to promote it.
- On mobile, they open in the inspector where available, or full screen otherwise.

## Side chats

Ask a quick side question about a thread without polluting its history. A side chat starts with the parent thread's context, folder, model, and permissions while the parent keeps working.

- **Start** (web/desktop): Send `/side <question>` or `/btw <question>`, or choose **Side chat** from the right panel's **+** menu.
- **Find later**: Listed under **Side chats** in thread details (web/desktop) or above the composer (mobile); hidden from the main sidebar.
- **Bring results back**: Click **Add to chat** in the side chat, or `@`-mention its title in the parent composer (not readable by external OpenCode servers).
- **Lifecycle**: Closing an unused side chat deletes it. Deleting or archiving the parent thread deletes or archives its side chats.

## Reopen handoffs in LastCode

LastCode remembers links and file chips you explicitly open from chat into the right pane,
and destinations opened there by an agent. Find them under **Handoffs** in the thread menu
or the right-pane **+** menu. Each entry keeps its Markdown label and reopens in its usual
file, browser, or pull-request tab. Files opened from the Files navigator are not added.

The menus show seven entries by default. Change **Handoffs shown in menus** in
**Settings → LastCode** to show 1–50. When more entries exist, **Show all…** opens a
searchable list; the menu limit does not delete older entries.

History stays on this client and survives closing tabs or archiving threads. Known local HTML
files receive fresh preview authorization when reopened. A saved URL still needs its original
server, and moved or deleted files must be restored before they can open again.
