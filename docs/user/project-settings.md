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

## Worktree settings

Configure worktrees in **Settings → Worktrees** (environment default or project override):

- **Branch naming**: Choose a static prefix (default `t3/`), model-selected semantic prefix (`feat/`, `fix/`), or custom instructions. Falls back to the temporary branch name if generation fails or collides.
- **Submodules** (under Advanced): Defaults to recursive checkout; set to **Top level only** or **Skip** (or `"worktreeSubmodules"` in `t3.json`) for repos with heavy nested submodules.
- **Sparse checkout**: Set `"worktreeSparsePatternsPath"` in `t3.json` to a repo-relative file of Git sparse-checkout patterns (non-cone syntax; requires Git 2.35+; enables `extensions.worktreeConfig`). Set Submodules to **Skip** if you don't want submodules initialized under excluded paths.
- **Worktree location** (per machine): Set an absolute path (e.g. `D:\worktrees` or `~/worktrees`) to store new worktrees elsewhere. Existing worktrees stay where they are; cleanup covers both folders.
- **Fast worktree checkout (macOS beta)**: Enable **Settings → Labs → Fast worktree checkout** (Git 2.42+) to clone new worktrees via APFS copy-on-write from a local cache. Falls back to normal checkout for cross-drive paths, sparse checkouts, or Git LFS/filter repos.

### Storage cleanup

Enable automatic cleanup in **Settings → Worktrees → Cleanup** (off by default; runs on startup, on change, and hourly). Projects can set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.

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

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

The inactive and settled retention periods also apply to the folders of
[threads without a project](./thread-sidebar.md#start-without-a-project). Those folders are not
Git repositories, so their files are deleted with them and cannot be recovered; the thread stays,
and its next turn starts in a new, empty folder. A folder is kept when it has a Git repository
anywhere inside it or when its thread has an enabled scheduled task. Every file in such a folder
counts as untracked, so only **Edited tracked files** removes a folder that holds anything other
than `node_modules`; the other two rules remove only empty folders. Folders that no thread uses
are listed here too.

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

## Let an agent run an Action and resume

Project Actions can hand long-running work back to Codex or Claude when they finish. Edit an
Action, enable **Allow Codex and Claude to run and resume**, and save it. When the agent launches
that Action, it can end its turn while the command runs in a dedicated terminal. LastCode sends one
automated follow-up after the command exits so the agent can continue the original task.

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

To delegate the workflow design and one-time setup, see
[use an agent to add resumable Project Actions](./resumable-project-actions-for-agents.md).

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
