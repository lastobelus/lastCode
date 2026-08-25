# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Thread annotations in LastCode

A thread can have one Markdown annotation for notes, headings, lists, task lists, and tags. In the
legacy sidebar, open a thread's context menu and choose **Annotate thread…**. An active annotation
adds a short dotted yellow underline to the thread timestamp; hover it to read, edit, or resolve
the note without opening the thread.

Opening an annotated thread shows the active note as a pale-yellow card above the composer. You
can dismiss the card for the current visit without deleting or resolving the note. The
conversation minimap marks the message that was newest when the annotation was created or last
changed. Editing, resolving, or reopening the annotation moves that marker to the newest message.
Resolved annotations disappear from the sidebar and composer but remain available from their
yellow minimap marker, where they can be edited or reopened.

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
Open **Settings -> LastCode -> Appearance** and adjust **Scale legacy sidebar** from 50% through 100%. The 75%
mark is labeled as a useful compact reference point. The default is 100%, and your selection is
stored locally and retained when LastCode restarts.

This setting compacts project headings and thread rows while keeping project favicons, action or
status icons, remote cloud indicators, and relative timestamps at their standard size. The
LastCode header, Search field, Projects heading, drafts, status notices, and footer also stay at
their standard size. On desktop, **View -> Actual Size**, **Zoom In**, and **Zoom Out** continue to
zoom the whole application and compose with the legacy sidebar scale.

To keep the same status colors while using less horizontal space, enable **Compact status
indicators** in **Settings -> LastCode -> Appearance**. Legacy thread rows then show only the
colored status dot; the full status remains available as a tooltip. This preference is off by
default.

## Environment icons in LastCode

Open **Settings -> LastCode -> Environments** to choose the icon color for the primary machine and
each saved remote environment. **Default** preserves the semantic icon treatment for each surface;
a custom color is shown at full strength in sidebar rows, project headings, and thread details. The
icon beside each environment name previews the selection.

Remote environments use a Server icon. The primary machine uses a Monitor icon, which can be shown
or hidden in thread cards and legacy thread rows with **Show local icon**. Legacy rows reserve the
same icon space either way so their columns stay aligned. Mixed legacy project groups always show
one icon for every environment in the group, including the primary machine, with duplicate
environments collapsed to one icon.
