# Durable Thread Worktree Cleanup Plan

## Goal

Deleting a thread with “Delete the worktree too” must create a durable cleanup job in the same persisted domain event as the thread deletion. The server owns that job until it succeeds or the user explicitly chooses **Keep worktree**. Closing a client, losing the connection, or restarting the server must not lose the cleanup.

The deleted thread remains visible as a temporary tombstone while cleanup is deleting, queued, or failed. Successful cleanup and explicit abandonment remove the tombstone silently.

## Product behavior

### Confirmation and navigation

- Keep the existing two-step delete confirmation.
- Web and desktop may request worktree cleanup. Mobile may delete a thread but does not offer worktree deletion.
- The server derives the repository root and worktree path from the authoritative project and thread records. The client sends only `deleteWorktree: true`; it does not supply paths.
- Reject a cleanup request unless the thread owns a linked worktree that no other live thread uses.
- Once deletion is accepted, immediately navigate an active thread route to the existing fallback. The tombstone is a sidebar status item, not an openable chat.
- Archive never schedules worktree cleanup.

### Lifecycle and queueing

- Persist cleanup intent and its initial state atomically in `thread.deleted`.
- Cleanup states are a separate lifecycle axis from agent states such as Working, Waiting, approvals, and input requests.
- The visible states are:
  - `deleting`: orange **Deleting**; the v2 sidebar also shows elapsed time.
  - `queued`: orange **Deleting (Queued)** with the blocking thread ID and title in hover details.
  - `failed`: red **Cleanup failed**; any click on the row opens the failure dialog.
- Cleanups for the same repository run one at a time in deletion order. Cleanups for unrelated repositories may run concurrently.
- On server start, reload deleting and queued jobs from the projection and resume them in deletion order. Treat a stale deleting state as resumable work.
- A failed cleanup releases its repository queue so the next queued cleanup can run.
- Retry re-enters the repository queue. If another cleanup owns it, persist queued state and its blocker; otherwise persist deleting state and start immediately.
- Success clears the cleanup state and removes the tombstone without a toast.
- **Keep worktree** is the only abandonment path and is available after a cleanup failure, when no removal is in flight. It clears the cleanup state and removes the tombstone without deleting the worktree.

### Failure dialog

- Clicking anywhere on a failed row opens a dialog containing the thread identity, worktree path, and exact cleanup error.
- Actions are **Retry**, **Copy details**, and destructive-looking but non-destructive **Keep worktree**.
- Retry closes the dialog after the server accepts it. Copy details keeps it open. Keep worktree requires confirmation because it permanently stops automatic cleanup.

## Domain and persistence design

### Contracts

- Extend `thread.delete` with optional `deleteWorktree: boolean`.
- Add a `ThreadWorktreeCleanup` discriminated union to thread shell/detail contracts. Each variant carries the authoritative repository root and worktree path:
  - deleting: `startedAt`
  - queued: `queuedAt`, `blockedByThreadId`
  - failed: `startedAt`, `failedAt`, `error`
- Add client commands for retry and abandonment, plus internal commands/events for queued, started, failed, and completed transitions.
- Keep new fields optional on the wire where compatibility with cached snapshots or older clients is required; absent means no cleanup.

### Decision rules

- `thread.delete` derives and validates cleanup ownership from the command read model.
- The decider chooses the initial deleting or queued state by inspecting unfinished cleanup jobs for the same repository. The resulting `thread.deleted` event contains the concrete cleanup record, making the user’s choice durable with the deletion.
- Retry and abandonment are valid only from failed. Internal lifecycle transitions validate their expected prior state.
- A failed job is not an active queue blocker.
- Thread creation and metadata updates cannot assign a worktree path reserved by an unfinished cleanup. The reactor also rechecks projected active owners immediately before physical removal.
- Project deletion is rejected while any child thread still has a cleanup state, even with `force: true`; the user must wait for cleanup or choose **Keep worktree** first.

### Projection

- Add a nullable JSON cleanup column to `projection_threads` through the next migration.
- Project every cleanup transition into that column.
- Include soft-deleted rows in shell snapshots and per-thread shell lookups only while cleanup is non-null. Completed or abandoned jobs disappear through the existing `thread-removed` shell event.
- Make `thread.deleted` use the same projection-backed upsert-or-remove decision as other thread events so the initial tombstone reaches every connected client.
- Expose a repository query for resumable deleting/queued jobs ordered by deletion time and thread ID.

### Reactor

- Extend `ThreadDeletionReactor`; it already owns provider-session and terminal cleanup for `thread.deleted`.
- Queue jobs through one scoped drainable worker per repository. Each worker preserves same-repository order while workers for different repositories proceed independently.
- Provider-session and terminal teardown completes before worktree removal begins. Before a queued job runs, persist the started transition, recheck active ownership, then call the server `GitWorkflowService.removeWorktree` primitive from PR #74 with `force: true`.
- Persist completed or failed with the exact structured error message.
- At startup, query and enqueue all resumable jobs after projections are bootstrapped. Tests wait on the reactor drain/receipts, never sleeps.

## Client presentation

### Shared behavior

- Cleanup state overrides agent status once deletion is accepted.
- Deleting and queued rows are muted, non-selectable, and use a no-entry cursor. Failed rows are clickable only to open their dialog.
- Preserve the thread title, short ID, project grouping, branch, and muted `FolderGit2Icon`. Do not invent a new worktree glyph or color the worktree icon orange.
- Exclude tombstones from keyboard thread traversal, bulk thread actions, drag/reorder, route fallback candidates, and unread/settled calculations.

### Legacy sidebar

- Render orange `• Deleting` and `• Deleting (Queued)` labels with the existing status-label proportions.
- Render red `• Cleanup failed`; the whole row is the dialog target.
- Append a cleanup segment after the regular hover content and after any annotation:
  - deleting: `Deleting worktree` and the formatted path.
  - queued: `Waiting for <short id> — <title>`.
- The segment background uses the deleting orange in light and dark themes. Text uses normal foreground in light themes and the darkest normal background token in dark themes.

### V2 sidebar

- Reuse the top-right status slot and dashed-circle visual language.
- Deleting shows orange `Deleting <elapsed>`.
- Queued shows orange `Deleting (Queued)` with no timer.
- Failed shows red `Cleanup failed`.
- Use the same shared hover content as the legacy sidebar.

### Mobile

- Decode and retain cleanup tombstones received from the server.
- Show deleting, queued, and failed cleanup status ahead of normal thread status resolution.
- Do not add a mobile control that initiates worktree deletion. Server restart/reconnect recovery remains fully visible on mobile.

## Validation

- Contract encode/decode tests for every cleanup state and command/event.
- Decider tests for ownership, shared-worktree rejection, atomic initial state, retry, abandonment, and transition invariants.
- Projection/migration/query tests for persistence, startup enumeration, shell inclusion, and final removal.
- Reactor tests with controlled removal effects proving same-repository ordering, restart recovery, success, failure, queue continuation, and drain semantics.
- Projection and shell-stream tests proving tombstones survive upserts and disappear on completion/abandonment.
- Web logic tests for status priority, route fallback exclusion, and cleanup pills shared by both sidebar variants.
- Mobile presentation tests proving observe-only status priority.
- Focused lint and package typechecks, committed-range `git diff --check`, and the guarded LastCode quick-CI push gate.
- Integrated disposable-state web QA in both sidebar versions, light and dark themes, covering deleting, queued, failure, Retry, Copy details, Keep worktree, navigation fallback, and silent success. Capture before/after images; record motion if elapsed/transition behavior needs review.

## Surface matrix

- Web: initiates cleanup and renders/controls the full lifecycle.
- Desktop: inherits web behavior; no new Electron IPC.
- Mobile: observes lifecycle but cannot initiate worktree deletion.
- Providers: not provider-shaped; existing deletion reactor stops any provider session first.
- Contracts/server/projections: required for durable remote and multi-device behavior.
- Local, relay, and tunnel connections: use the same persisted orchestration commands and shell stream; disconnects do not own job lifetime.
- Documentation: the implementation plan and LastCode section of the user sidebar guide document this fork-only behavior.
