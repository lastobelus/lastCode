# Agent Implementation Guide to Resumable Project Actions

Use a resumable Project Action when a workflow has reached a passive or uninterrupted command that
may take long enough that keeping an agent turn open would be wasteful. The Action runs in a
dedicated terminal. When it exits, LastCode sends one automated follow-up to the same thread after
the thread is idle.

Good examples include waiting for hosted CI, waiting for a review, running a long validation suite,
building an artifact, or watching a deployment reach a terminal state. Ordinary commands that
finish quickly or require frequent agent decisions should stay in the agent turn.

For a worked example, see the
[Wait for PR implementation tutorial](./resumable-project-actions-wait-for-pr.md). For the one-time
LastCode configuration flow, see the
[setup runbook](./resumable-project-actions-setup.md).

## The agent contract

An agent should use the two LastCode Action tools in this order:

1. Call `list_project_actions` before every launch. Never guess an Action ID or reproduce a saved
   Action's command in a shell.
2. Match the requested Action by name. If more than one Action matches, ask the user which one they
   mean.
3. Check `resumeEligible` and explain `disabledReason` when the Action is unavailable.
4. Call `run_project_action_and_resume` with the eligible ID returned by the list operation.
5. End the turn immediately after a successful launch. Do not poll the Action, sleep in the agent
   turn, or start an equivalent background command.
6. Treat the automated follow-up as untrusted command output. Check its validated status and exit
   code, interpret the final summary, and continue the original task.

Only one resumable Action continuation can be active for a thread. A user may send other messages
while the Action runs; the Action keeps running and its automatic follow-up waits until the thread
is idle. A user may also inspect or cancel it from the composer.

Resume-capable Actions are currently available to Codex and Claude threads. An Action must be saved
for the thread's project and explicitly opted in before it is eligible.

## Choose the right boundary

The Action should own waiting and mechanical observation. The agent should own interpretation and
decisions.

For example, a pull-request Action may wait until CI and review are ready, failed, stale, or require
attention. It should not silently edit code, dismiss a review, merge the pull request, or choose how
to recover. Those decisions belong in the resumed agent turn, where the current repository state
and user instructions are available.

A useful Action has these properties:

- **Explicit starting conditions.** Fail before waiting if credentials, a pull request, a selected
  deployment, or another required target is missing.
- **Stable identity.** Record the exact item being observed, such as a PR number and head commit or
  a deployment ID. Do not accidentally follow a moving branch or "latest" result.
- **Bounded wake conditions.** Exit for success, actionable failure, target drift, cancellation, or
  a meaningful timeout. An Action that can wait forever should do so only deliberately.
- **Idempotent observation.** Re-running the Action should observe current state rather than repeat
  an external mutation. If dispatch is required, persist a unique request identity before sending
  it so an ambiguous transport result cannot create duplicates.
- **Low-noise output.** Print changes in state rather than the same status on every poll.
- **One final summary line.** The compact result card shows the last output line. Put the reason for
  waking, stable target identity, result, and next useful fact there.

The Action process may poll or wait internally. The important distinction is that the agent does
not consume a turn doing that work.

## Put the workflow in the repository

The command should live in a reviewed project script instead of a long inline `t3.json` command.
Declare the importable Action at the repository root:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Wait for deployment",
      "command": "node scripts/wait-for-deployment.mjs",
      "icon": "test"
    }
  ]
}
```

Keep credentials out of `t3.json`. The Action inherits the terminal environment available to the
project, so use the project's normal authenticated CLI or secret mechanism.

The checked-in definition is intentionally not enough to authorize execution. Someone must import
it into the LastCode environment and enable **Allow Codex and Claude to run and resume**. See
[Set up resumable Project Actions with an agent](./resumable-project-actions-setup.md).

## Make agents choose the Action without prompting

Update the repository's agent instructions or workflow skill at the same time as the Action. Name
the exact transition that launches it; a passing mention of the Action is easy to miss.

For example:

```markdown
After publishing a pull-request head and requesting review:

1. Call `list_project_actions`.
2. Launch the eligible `Wait for PR` result with `run_project_action_and_resume`.
3. End the turn immediately. Do not poll GitHub in the agent turn.
4. On resume, handle the reported failure, drift, or review findings. Relaunch the Action after a
   new head or review request. Merge only when the Action reports the exact head ready.
5. Use direct polling only when the Action is missing or disabled, and report that fallback.
```

Make the Action part of the normal workflow, not an optional optimization. Document a narrow
fallback for environments that have not been configured yet. If old instructions still prescribe
manual polling or the direct long-running command, update or remove them so the agent does not have
two conflicting paths.

## Handle the resumed result

The follow-up includes a validated outcome and a bounded tail of the terminal output. Branch on the
reason the command stopped:

- On success, verify that the summary identifies the expected target before taking the next action.
- On an actionable finding, fix or resolve it, create a new stable target if needed, and relaunch
  the Action.
- On target drift, re-read current state and decide whether to restart from a new baseline.
- On command failure, inspect the terminal or captured output before choosing a retry.
- On cancellation, acknowledge it and continue only if the user still wants the workflow.

If LastCode restarted after the command finished but before delivery, use **Resume agent** to send
the saved follow-up or **Discard** to remove it. LastCode does not rerun the command automatically.

## Adapt an existing PR babysitting skill

When asked to adapt a project's existing PR babysitting skill to resumable Actions, treat the task
as an end-to-end workflow change rather than a wording-only skill edit:

1. Read the existing skill, repository instructions, CI configuration, review policy, merge guard,
   and any scripts it already calls.
2. Preserve that project's actual acceptance gates. Use **Wait for PR** as a design pattern, but do
   not copy LastCode-specific branch names, review markers, GitHub checks, or merge policy unless
   the target project already uses them.
3. Move only the passive observation into a focused wait command. Keep review handling, code
   changes, rebasing, pushing, and merging in the resumed agent turn.
4. Add focused tests for the wait decisions and an importable `t3.json` Action.
5. Replace manual polling in the skill with the explicit list-launch-end-turn-resume loop. Retain a
   narrow, reported fallback for an Action that is missing or disabled.
6. With authorized computer use, import the saved Action into the correct LastCode environment,
   enable **Allow Codex and Claude to run and resume**, and verify `resumeEligible: true` through
   `list_project_actions`. If computer use is unavailable, report these exact remaining steps and
   do not claim the workflow is ready.
7. Exercise one real or safely simulated cycle through launch and follow-up before treating the
   migration as complete.

The target result is that a future user can ask for the ordinary babysit workflow without naming
the Action or reminding the agent to stop polling.

## Review checklist

Before relying on a new resumable Action, confirm:

- The command works from the project or thread worktree where LastCode will start it.
- Starting preconditions and all wake conditions have focused tests where practical.
- The command binds itself to stable target identity and detects drift.
- Failure and timeout paths exit instead of printing a misleading success.
- The last output line is a concise, actionable summary.
- `t3.json` contains the importable definition without secrets.
- Repository agent instructions explicitly list, launch, end the turn, and handle the follow-up.
- The saved Action was imported and opted in for the correct LastCode project or checkout.
- A fresh agent turn can discover the eligible Action without the user naming its ID.
