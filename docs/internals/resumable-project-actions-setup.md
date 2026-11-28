# Runbook: Maintain Resumable Project Actions

Use this runbook for an existing workflow that still needs the legacy
agent-launch fallback or for recovering an Action already in flight. New agent
workflows use direct commands with background waits.

Agent-launched Project Actions require `lastcodeBackgroundWaitEnabled` to be off
when the provider session starts. In LastCode checkouts, follow the
[`lc-run` workflow](../../AGENTS.md#dev-servers-and-test-data) in either setting.

The UI step remains deliberate. A command checked into a repository is not automatically trusted
for agent execution, and importing it does not enable resume permission.

## A prompt for restoring an existing fallback

Use a request like this:

```text
Restore the legacy Action fallback for <workflow>. Verify the existing command
and t3.json entry. Keep the direct command as the normal path. Then, subject to the machine
interaction policy, use the collaborative browser to import the Action into this LastCode
project, enable “Allow Codex and Claude to run and resume,” and verify it with
list_project_actions. Do not edit LastCode's live database directly. Stop for my input only if
authorization, credentials, or a workflow decision is genuinely required.
```

If the repository already contains the command and `t3.json` entry, ask the agent simply to inspect
them, complete the LastCode UI setup, and verify eligibility.

## What the agent should do before opening Settings

The agent should first make the repository self-describing:

1. Read the project's agent instructions and current workflow implementation.
2. Identify the passive portion that should run without an open agent turn.
3. Implement or tighten the command so it has stable target identity, explicit wake reasons,
   failure handling, and one concise structured result. If the Action cannot use the reporting kit,
   print the same summary as its final output line.
4. For protocol-aware long-running commands, emit coarse `working` and `waiting` progress only when
   the useful phase or summary changes.
5. Add an importable entry to the repository-root `t3.json`.
6. Document when an existing Action is the fallback and how to verify its result.
7. Run focused checks for the command and validate the `t3.json` syntax.

Do not put credentials or environment-specific secrets in `t3.json`. Do not add a second manual
polling path unless it is a clearly labeled fallback for an unavailable Action.

## Let the agent complete the UI setup

When the user has requested or authorized computer use, the agent should follow the applicable
machine interaction policy and use the product-native collaborative browser when available.

The agent should:

1. Attach to or open the real LastCode client connected to the environment that owns the thread.
   Do not configure a disposable development instance by mistake.
2. Open **Settings → Projects** and select the correct project and checkout.
3. Under **Actions**, choose **Import scripts** and select the Action under **Import from
   t3.json**. If the definition does not appear, confirm that the selected project's root contains
   the current `t3.json`, then reload the client.
4. Edit the newly saved Action.
5. Review its name and command, enable **Allow Codex and Claude to run and resume**, and save the
   change.
6. Return to the thread and call `list_project_actions`.
7. Confirm that the expected name and stable ID appear with `resumeEligible: true`.

The agent may add the Action manually with **Add action** when no checked-in definition exists, but
the preferred result is a reviewed `t3.json` entry that other environments can import.

An agent should not write directly to LastCode's live SQLite database to bypass the UI. Besides
being unsafe, that would skip the explicit trust decision represented by the opt-in control.

## Know which parts are per environment

There are two separate layers:

- `t3.json` is checked-in project configuration. It makes a command discoverable for import by
  anyone who opens that repository.
- Saved Project Actions belong to a LastCode environment and checkout. Importing creates the saved
  Action, and enabling resume records that environment's explicit permission.

Updating or rebasing `t3.json` does not retroactively create, update, or authorize saved Actions.
Each LastCode environment that should run the workflow needs the one-time import and opt-in. If a
project has multiple checkout entries, configure the checkout that owns the relevant threads.

This separation is why the agent must verify with `list_project_actions` instead of assuming that a
visible `t3.json` definition is ready to run.

## Verify the legacy fallback

Verify in a session where the setting is off and the fallback is required.
Ask the agent to use the existing saved Action and continue from its result.

A successful verification looks like this:

1. The workflow reaches its documented passive wait.
2. The agent lists saved Actions without being reminded.
3. The agent launches the eligible Action by returned ID and ends the turn.
4. The Action result returns to the same thread.
5. The agent interprets the result and either continues, relaunches after a new target, or asks for
   a real decision.

If the agent manually polls instead, inspect the repository guidance first. Common causes are stale
or conflicting workflow instructions, a skill that mentions the Action without prescribing the
tool sequence, or an Action that is missing or disabled in the current environment.

## PR watches for delegated children

A child owns its PR watch only when the parent separately verifies
`features.appOwnedPullRequestWatchContinuationVersion` and explicit Phase 4
acceptance of the destination's installed checkpoint in #482, or a narrowly
authorized isolated acceptance scenario applies. Otherwise the parent keeps
the watch. Watches already handed to a parent stay with that parent.

## In-flight Action runs

Inspect or recover an existing Action run from the thread that launched it.
For an Action a parent already launched on a child's behalf, that is the
parent's thread. There, `t3_thread_read` shows the latest Action summary and
`inspect_action_run` shows its output; to recover an interrupted run, see
[An interrupted Action blocks new launches](#an-interrupted-action-blocks-new-launches).
The runtime keeps an unfinished Action and its pending follow-up from automatic
settlement with no setting change. An explicit Stop or Settle from the user
still stands.

## Troubleshooting

### The Action list is empty

The `t3.json` definition has probably not been imported for this saved project or checkout. Import
it in **Settings → Projects**, then verify again.

### The Action is listed but disabled

Read `disabledReason`. The usual cause is that **Allow Codex and Claude to run and resume** is off.
The provider may also be unsupported, or the thread may already have an Action continuation in
progress. For an interrupted continuation, see [An interrupted Action blocks new launches](#an-interrupted-action-blocks-new-launches).

### An interrupted Action blocks new launches

When an Action's continuation is interrupted, it stays open and new Actions in that thread are
disabled until someone recovers it. Use **Resume agent** in the composer or
`resume_interrupted_action` to queue the retained result and follow-up. Use **Discard** in the
composer to drop the follow-up. Agents can also call `discard_interrupted_action` in sessions
with `lastcodeBackgroundWaitEnabled` turned off.

These controls act in the thread that owns the Action. A parent-launched Action is recovered in
the parent's thread, and a child-owned Action in the child's thread. Resume does not rerun the
command, and Discard does not record success. Both require available result delivery and leave
running or pending follow-ups in place.

### The import menu does not show the new definition

Confirm that the selected project or checkout points at a root containing the updated `t3.json`.
Existing saved Actions do not update just because the file changed. Reload LastCode after updating
the persistent project root, then reopen the import menu.

### The agent runs the command directly

Direct execution is the normal path. If this session needs the fallback, check
that it has the legacy tools and the saved Action is eligible.

### Computer use is unavailable

The agent can still finish the command, `t3.json`, tests, and workflow instructions. It should then
report the exact remaining UI steps and leave the Action disabled until a user or a later authorized
agent completes them. It should not claim that resumable execution was verified.
