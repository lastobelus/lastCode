# Settings and project overrides

T3 Code separates **device preferences** (saved locally per browser/device, like Appearance and Confirmations) from **server settings** (stored on each environment, like Threads, Worktrees, and Source control).

## Scope and inheritance

Use the **"Applying settings for …"** selector at the top of Settings (web/desktop) or the header filter (mobile) to choose which **environment(s)** and **project** you are editing:

- **All environments**: Bulk-edits every currently connected environment (offline environments keep their values). Controls show **Mixed** where environments disagree.
- **Project scope**: Creates a project override for that setting without changing environment defaults. Settings that cannot be overridden appear read-only.
- **Inheritance order**: `Project override` → `Environment setting` → `t3.json` in the repo → `Built-in default`. Leave a setting on **Inherit** to defer to the next tier.
- Click the **layers icon** beside a server setting to inspect its inheritance chain, jump to overriding projects, or **Reset all** back to the environment default.
- **Per-project providers**: With a project selected in **Settings → Providers**, toggling a provider enables or disables it for that project only (in either direction). Running turns finish; no new turns start on a disabled provider.

In LastCode, **Settings → LastCode → Local CI** uses the same page selector. These preferences
apply to all projects on an environment. With a project selected, the Local CI section offers
connected environments that support it; choosing one switches to that environment's defaults.
If any selected connected environment does not support Local CI, the section offers supporting
environments instead of editable controls. Offline environments keep their current settings.

## Pin and archive projects

- **Pin**: Pinned projects sort first in project pickers, the command palette, the sidebar filter, and mobile (`mod+shift+p` on a highlighted row, or **Settings → Projects**).
- **Archive**: Archive finished projects in **Settings → Projects** (mobile: **Settings → Projects → Organize**). Archived projects leave pickers while keeping their threads, settings, and files; unarchive anytime from Settings.
- Pinning or archiving a project that exists on multiple machines requires all of those machines to be connected.

## Project icons and multi-repo projects

- **Icons**: In **Settings → Projects**, set an icon, emoji, monogram, or image (applies across checkouts). Without one, T3 Code generates a two-character monogram (or single CJK character) from the project name.
- **Multiple repositories**: See [Projects with several repositories](./multi-repo-projects.md).

## Choose the icon shape

Project icons keep the shape of their source image by default. To round their corners in the web
or desktop app, open **Settings → LastCode** and enable **Rounded project icons**. This preference
is saved in the current LastCode profile.

T3 Code Mobile stores the same preference separately on each device. Open
**Settings → Appearance** and enable **Rounded project icons** on every mobile device where you
want rounded corners.

## Worktree settings

Configure worktrees in **Settings → Worktrees** (environment default or project override):

- **Branch naming**: Choose a static prefix (default `t3/`), model-selected semantic prefix (`feat/`, `fix/`), or custom instructions. Falls back to the temporary branch name if generation fails or collides.
- **Submodules** (under Advanced): Defaults to recursive checkout; set to **Top level only** or **Skip** (or `"worktreeSubmodules"` in `t3.json`) for repos with heavy nested submodules.
- **Sparse checkout**: Set `"worktreeSparsePatternsPath"` in `t3.json` to a repo-relative file of Git sparse-checkout patterns (non-cone syntax; requires Git 2.35+; enables `extensions.worktreeConfig`). Set Submodules to **Skip** if you don't want submodules initialized under excluded paths.
- **Worktree location** (per machine): Set an absolute path (e.g. `D:\worktrees` or `~/worktrees`) to store new worktrees elsewhere. Existing worktrees stay where they are; cleanup covers both folders.
- **Fast worktree checkout (macOS beta)**: Enable **Settings → Labs → Fast worktree checkout** (Git 2.42+) to clone new worktrees via APFS copy-on-write from a local cache. Falls back to normal checkout for cross-drive paths, sparse checkouts, or Git LFS/filter repos.

### Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Rules start off. The server runs enabled rules on a schedule and after relevant
policy or worktree changes. Offline machines keep their existing policies.

Use **Settings → Maintenance → Automatic cleanup** to set the minutes between scheduled runs.
The default is a full sweep every 60 minutes. Turn on **Alternate what gets cleaned** to run
dependency and build cleanup on one scheduled run and the rest on the next. On macOS,
**Wait for Time Machine** delays automatic cleanup while a backup is running or macOS cannot
report its status. LastCode checks again every five minutes. **Delete now** runs a full sweep
when you ask for it.

#### Suspend worktrees

Use **Suspend inactive worktrees** to save local work and put away a checkout without archiving
its conversation. Choose a delay and which threads may suspend: subagents, untouched
agent-created children, or other threads. These choices start Off. A separate child checkout
can suspend while its parent remains open; a shared checkout stays until every owner qualifies.
The delay starts from settlement or the last workspace use or restore, whichever is later. An
archived thread that never settled counts from its archive time instead of settlement.
Automatic suspension closes the eligible owners' previews before saving the workspace.
If another process is still using the checkout, or its safety cannot be verified, the checkout stays in place.
Project **Off** pauses automatic suspension as well as cleanup.

You can also choose **Suspend worktree** from a thread's menu. Staged changes, unstaged changes
and supported local files, including ignored notes, are saved before the checkout is removed.
Active work and unsupported or oversized workspaces are kept. Suspension does not change any
existing permanent deletion rule; those rules remain under **Permanent deletion**.

Continuing work restores the current saved copy first. Manual **Restore worktree** also enables
**Keep workspace**, which protects it from automatic suspension, dependency/build cleanup and
permanent worktree cleanup. Release that hold separately when you are ready for the configured
rules to apply again. Releasing a hold does not restart an already elapsed cleanup delay.

Open **Saved workspaces** on this page to restore or deliberately discard saved copies.
Archive keeps them; **Archive and discard saved workspace** combines both choices. Thread and
project deletion let you discard saved data or keep it for recovery. Discarding a current copy
does not require restoring it first, and permanently loses its saved uncommitted work and notes.
Git branches and ordinary checkpoints remain. After discarding, use **Create fresh worktree**
to continue from Git rather than recover the discarded changes.
For a discarded scratch copy, **Create fresh worktree** creates an empty scratch folder.
Copies kept after deleting their threads remain in Saved workspaces; an environment administrator
can release their hold and discard them there.

Saved workspaces have no automatic expiry. They are local recovery, not a backup: restoration
of a saved scratch workspace needs only this environment's saved data. A saved Git worktree
also needs the repository's Git data.

On Linux, suspension needs `getfattr`, `getfacl`, and `lsattr` to check file metadata before
removing a checkout. Install your distribution's `attr`, `acl`, and `e2fsprogs` packages if
these commands are missing. The checkout is kept when its metadata cannot be verified.

#### Permanent deletion and generated files

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off disables automatic worktree deletion and dependency
removal for that project. Custom applies separate worktree rules to the selected project or checkout.
Browser captures and log retention remain machine-wide.

When **Delete inactive worktrees** is enabled, clean archived checkouts are eligible
immediately. Unarchived checkouts use the delay configured in settings. Worktrees can also
be removed after a thread settles, after merging, or when they have no commits beyond the
default branch and their thread is settled or archived. Set settled retention to 0 days to remove an eligible checkout at the next
cleanup after settlement. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the project workspace;
if that checkout has a detached HEAD, the worktree is kept. Only
registered linked worktrees in configured cleanup locations are eligible. Active consumers
prevent removal. Shared families qualify only when every owner is archived and every owner
has cleanup enabled. Edits, untracked files and unknown ignored files—including notes, `.env`
and local runtime state—always preserve a checkout. Branches and thread history stay;
starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

The latest cleanup results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

[Scratch workspaces](./thread-sidebar.md#start-without-a-project) are eligible after every thread
using the folder is archived or deleted and the inactivity delay has passed. Their contents are
saved first and can be restored from Saved workspaces.

Enable **Remove inactive dependencies and build outputs** to reclaim recognized npm or
pnpm `node_modules` installations and unchanged build files recorded by the compiler runners.
This existing dependency rule also governs verified app `dist` and resource-monitor debug
outputs; source checkouts remain subject to the separate whole-worktree rule. Additions,
notes and research files are kept. Archived threads are eligible immediately when this rule is enabled. For shared
worktrees, every owner must be archived and have cleanup enabled; an unarchived or active
owner, or an owner whose project policy is Off, keeps the install.

Unarchived and ownerless installs use the delay configured in settings, measured from actual
dependency or compiled-output use. This includes registered manual and QA worktrees in configured cleanup
locations when their repository maps to one project. Dependency preparation and the
dependency-backed development and CI runners renew that clock; status conversations and
simply opening a terminal do not. Recognized installs with uncertain usage start a full
configured interval when first observed. Folder timestamps alone never prove usage.

Active agents, sessions, terminals, previews, processes, and runtime protection prevent
cleanup. Only unchanged compiler-recorded or explicitly approved files are removed from build
folders; arbitrary additions and edited outputs remain. Other generated folders and vendored sources
are kept. Reinstall dependencies or rebuild outputs before continuing work. This rule is off by default and follows the project's Inherit, Off,
or Custom policy. Dependency cleanup is available on macOS and Linux and keeps worktrees
when consumers cannot be checked reliably. On mobile, open **Settings → Maintenance** to
configure cleanup for an environment or project.

For older builds, choose **Settings → Storage → Review older builds** on web or desktop.
Choose an environment and build root, then explicitly select the files to approve. Saving
does not delete files or enable cleanup; the existing policy and delay still apply. New,
changed, recreated and unselected files stay. Clearing approval keeps the build root protected.
Each review supports up to 1,000 files and 512 MiB per root.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project Actions and agent waits

Run saved Project Actions from your project. Agents normally run long commands directly,
using [background waits](./resumable-project-actions-for-agents.md) to continue when they finish.
In an environment using legacy agent launches, **Allow Codex and Claude to run and resume** opts
a saved Action into that fallback.

Protocol-aware Actions can also report a short current status while they run. LastCode shows
**Working** for active phases and **Waiting** when the command is paused on CI, review, approval, or
another external condition. The current summary appears in the composer Action shoulder and Action
details; thread lists keep the narrow row to the status label.

Completed Actions show a compact result with a standard icon and label for success, attention,
blocked, execution failure, interruption, or cancellation, plus the structured summary reported
by protocol-aware commands. The dedicated Action terminal retains the detailed
output, and the resumed agent can inspect a bounded tail when the compact result is not enough.
Older Actions still use their final output line as the compact summary and keep their captured tail
expandable in the thread.

For a useful compact result, have a protocol-aware Action report one concise summary containing the
result the agent needs next, such as which checks passed, why a wait ended, or what requires
attention. Actions that do not use the reporting kit should print that summary as their final
output line.

## Keep the default branch current

Enable **Settings → Source control & issues → Automatically pull** to fast-forward clean default-branch checkouts from their configured upstream. Skips checkouts with local changes, untracked files, local commits, other branches, or no upstream.

## Scheduled tasks and webhooks

Create and manage scheduled tasks in **Settings → Scheduled tasks** (web, desktop, and mobile).

- **Schedules**: Recurring fixed-time schedules use the target environment's time zone. **Once** uses your local time zone (runs on reconnect if offline).
- **Destination**: Choose **New thread each run**, **One thread (continue conversation)**, or **One thread (fresh session each run)**. Deleting a target thread deletes tasks bound to it; archiving a target thread causes runs to fail (settle it instead).
- **Controls**: Edit, pause, resume, run now (except webhook tasks), or delete from the list.

### Webhook automations

Choose **On webhook** as a task's schedule to trigger runs from external services (e.g., GitHub PR or CI events). A public URL requires a [T3 Connect](./remote-access.md) tunnel; click **Rotate** to invalidate and replace the URL.

- **Prompt placeholders**: Insert `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`, or `{{request}}`. Missing values render empty.
- **Untrusted input protection**: Placeholder values are wrapped in `<webhook-data-…>` tags, and `$`/`@`/leading `/` tokens are neutralized so untrusted payloads can't invoke skills or commands.
- **Signatures** (web/desktop setup): Enable **Require signature** to verify HMAC signatures (for GitHub, keep `x-hub-signature-256`, hex, and `sha256=` prefix with the same secret and `application/json`).
- **Filters**: Add conditions (using paths without braces, e.g. `headers.x-github-event` equals `pull_request`, or `body.action` is one of `opened, reopened`). All filters must match; non-matching requests are logged as **Filtered**.
- **Deduplication & coalescing**: Set a **Duplicate request key** (e.g. `{{headers.delivery-id}}`; ignores repeats for 7 days) or a **Coalesce key** with a 10–3600s window (default 120s; runs once with the latest payload when the window closes). Coalesced updates are rate-limited to 60/min (`HTTP 429`).
- **Offline delivery**: By default, offline environments return an error. Enable **Settings → Sharing & access → Hold webhooks while offline** to buffer T3 Connect webhooks for up to 24 hours, and optionally set **Skip requests older than** on the task.
- **Debugging**: Open **Deliveries** from a task's menu (web/desktop) to inspect recent payloads and rendered prompts.
