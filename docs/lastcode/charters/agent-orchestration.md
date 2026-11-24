---
area: agent-orchestration
title: Agents directing agents
tier: prefer-ours
paths:
  - apps/server/src/mcp/
  - apps/server/src/peer/RemoteDelegation.ts
  - apps/server/src/orchestration-v2/ProviderTurnStartService.ts
  - apps/server/src/orchestration-v2/ThreadManagementService.ts
  - apps/server/src/orchestration-v2/pullRequestWatch.ts
  - apps/server/src/orchestration-v2/PullRequestWatchReactor.ts
  - apps/server/src/pullRequest/
  - apps/server/src/scheduledTasks/
  - apps/server/src/provider/CodexThreadTool.ts
  - apps/server/src/cli/thread.ts
---

# Agents directing agents

## Purpose

An agent can hand work to other agents, wait on long-running work, and pick up the result without anyone watching. The owner should be able to start a piece of work, walk away, and come back to it finished or clearly stuck, never silently dropped and never burning turns on polling.

## Intents

### Delegated tasks and child threads

- A delegated child's result reaches the task that owns it exactly once, even across restarts, ordinary turns and cancelled rounds.
- A child stays owned by its parent while it waits on long-running work or a PR watch; a wait is not a handoff, and the parent is not woken to poll it.
- Cancelling a task cancels its owned work, including work it is waiting on, and nothing beyond it.
- Delegation to a linked machine keeps moving: the child runs there, its approvals and results route back to the parent, and access granted to the parent is kept across automated turns.

### Thread tools for agents

- Agents can find, read and message threads on this machine and on linked machines by id, without the user tracking which machine owns a thread.
- Codex sessions get `lastcode-thread` (current, list, read, send, wait) on their `PATH`; `send` confirms only what was persisted, and `--wait` returns the exact resulting turn.

### Waiting without polling

- An agent can wait on long-running work, such as CI, a build or a checkpoint, without spending turns polling, and continues with the result when the work finishes.

### Scheduled tasks

- A scheduled task can choose its model.

### PR and issue follow-through

- An agent can watch a PR and is woken on checks, reviews, comments and conflicts, instead of polling.
- A child can own a PR watch when its environment supports it; the watch carries no merge authority.
