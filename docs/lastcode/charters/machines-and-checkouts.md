---
area: machines-and-checkouts
title: Machines and worktrees
tier: prefer-ours
paths:
  - apps/server/src/peer/
  - packages/ssh/
  - apps/server/src/environment/
  - apps/server/src/capacity/
  - apps/server/src/workspace/
  - apps/server/src/storageCleanup.ts
  - apps/server/src/storageCleanupSchedule.ts
  - apps/server/src/orchestration-v2/ResourceCleanupService.ts
  - apps/server/src/orchestration-v2/WorktreeCleanupService.ts
  - apps/server/src/mcp/toolkits/worktreeSuspension/
  - apps/web/src/components/EnvironmentPauseControl.tsx
  - apps/web/src/components/settings/LastCodeStorageSettings.tsx
  - apps/mobile/src/features/threads/EnvironmentPauseControl.tsx
---

# Machines and worktrees

## Purpose

The owner runs agents on several machines and in many checkouts at once. Work started on one machine can be reached, paused and archived from another, and checkouts that are no longer in use give their disk back without ever losing unsaved work.

## Intents

### Linked environments

- Machines link through an address each can actually reach and verify.
- Archiving or restoring a thread family also archives or restores the work it owns on linked machines.

### Pausing and resuming an environment

- One click pauses an environment before going offline: every active thread is asked to stop, automatic wake-ups and PR watch polling are held, and nothing is lost when the environment comes back.
- Resume works while a pause is still settling, and work that finished during the pause is delivered on resume.
- Each environment shows its own pause state, on web, desktop and mobile.

### Worktree lifecycle (suspend, hand off, restore)

- A settled or inactive worktree can be suspended: its uncommitted changes and supported local files are saved, and the checkout is removed. Continuing the thread restores it first.
- Suspension never removes a checkout that is in use or whose safety cannot be verified, and a shared checkout stays until every owner qualifies.
- Saved workspaces do not expire; the user restores or discards them deliberately.

### Storage cleanup

- Cleanup reclaims dependencies, build output and old worktrees only after checking each worktree's own owners and activity, and it can run on a schedule.
- A failed cleanup or save leaves the original usable and says what blocked it.

### Machine capacity

- Agents and the user can see how busy each machine is, and an unknown reading is reported as unknown.
