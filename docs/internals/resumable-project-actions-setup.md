# Implementation Runbook: Set Up Resumable Project Actions With an Agent

An agent can do nearly all of the setup for a resumable workflow: identify the passive wait, write
and test its command, add the importable `t3.json` entry, update repository instructions, and use
LastCode's UI to import and opt in the Action. The user should not have to transcribe commands or
remember the setup sequence.

The UI step remains deliberate. A command checked into a repository is not automatically trusted
for agent execution, and importing it does not enable resume permission.

## A prompt that delegates the whole setup

Use a request like this:

```text
Turn <workflow> into a resumable Project Action. Inspect the repository and existing workflow,
implement and test a command that waits for stable terminal states, add it to t3.json, and update
our agent instructions so future threads use it without prompting. Then, subject to the machine
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
6. Update the repository's agent instructions or workflow skill with the exact
   list-launch-end-turn-resume sequence.
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

## Make future threads use it automatically

After setup, start a fresh turn and ask for the normal workflow rather than naming the Action. The
repository instructions should cause the agent to discover and launch it at the right boundary.

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

## Parent-mediated Actions for delegated children

App-owned delegated child tasks do not yet complete reliably across an Action wait, so for now
their parent owns every resumable Action they need, including dependency preparation, CI, build,
and checkpoint waits. A child can technically call `run_project_action_and_resume`; the injected
runtime instructions ask it not to. Child PR watches stay with the parent as well. Ordinary
top-level threads launch and resume their own Actions directly; nothing in this section, including
settlement protection, applies to them. Issue #482 tracks the work that removes this handoff.

The injected instructions carry the sequence each side follows: the child ends its turn with a
handoff request as its final response, and the parent waits for that recorded result, keeps
itself from being settled away, verifies the target, launches, and queues the result back to the
child with a `taskId` receipt. This section holds the setup detail they leave out.

### Choose the target

A listed, eligible Action shows only that it exists and is opted in. Use `t3_project_read` to
inspect the registered workspace and saved scripts, and `t3_thread_read` to check the parent's
checkout. Before launching for a child, verify the saved command, opt-in, effective working
directory, environment, and worktree-local package or build selection against the child's exact
checkout and head. Use **Settings → Projects** when importing, changing, or opting in an Action;
reading its definition does not itself need a UI visit.

- **Shared checkout.** When the child works in the parent's checkout, the parent's saved Action
  usually targets it already; verify it as above. Serialize changes to that checkout while the
  Action runs.
- **Separate child worktree.** The parent needs a saved Action explicitly targeted at that
  worktree and opted in, set up as in [Let the agent complete the UI setup](#let-the-agent-complete-the-ui-setup).
  Its setup must not depend on packages the child's worktree is still missing. Keep concrete
  paths and selections in the environment's settings, not in repository files.

If a correctly targeted Action cannot be prepared, use the shared checkout when that is safe, and
otherwise report the specific blocker before launch.

### Protect the parent from automatic settlement

A parent whose linked PRs have merged can be settled automatically, and filed away, while it still
owes a child its result. Protection keeps it visible until the relay is done. It does not enable
anything: `run_project_action_and_resume` never checks it, and Actions launch and resume the same
way with or without it. When asking the user, give the visibility reason. The parent thread's
existing menu control disables automatic settlement for that thread; `t3_thread_read` reports the
current value as `autoSettleDisabledAt`, and no MCP tool changes it.

Set protection up once per mediated workflow, then reuse its record for later Action requests.

1. Read and record the current value. If it is already set, keep that timestamp as the receipt,
   skip setup, and restore nothing you did not change.
2. If it is unset, ask the user to disable automatic settlement from the parent thread's menu, or
   use the collaborative browser if the user has already authorized that setup under the machine
   interaction policy. Read the value again and record the timestamp as the receipt.
3. Before later requests, confirm protection still matches that receipt. If it changed, respect
   the user's choice and report the blocker rather than changing it back.

If setup is needed and neither route is available, report that blocker. After the workflow
finishes, restore only a setting changed for this workflow, through the same authorized route,
and only if the current timestamp still equals the receipt and later user choices permit it.
Otherwise leave it and explain why. An explicit Stop or Settle from the user always stands.

### Observe progress

A parent reads the bounded latest-Action summary through `t3_thread_read`: identity, outcome,
delivery, timing, exit, derived follow-up status, and an untrusted report summary. A mediated
Action belongs to the parent's own thread; reading the child does not show that parent-owned run.
The retained hold flag and raw output are available only through `inspect_action_run` in the
thread that launched the run, which for mediated Actions is the parent.

### When the handoff ends

The restriction lifts only after an installed checkpoint containing same-task Action support
passes acceptance on that environment. A newer source tree or version number is not enough, and
no capability flag reports it yet. Mediated work already in flight keeps its recorded owner until
someone deliberately hands it over.

## Troubleshooting

### The Action list is empty

The `t3.json` definition has probably not been imported for this saved project or checkout. Import
it in **Settings → Projects**, then verify again.

### The Action is listed but disabled

Read `disabledReason`. The usual cause is that **Allow Codex and Claude to run and resume** is off.
The provider may also be unsupported, or the thread may already have an Action continuation in
progress.

### The import menu does not show the new definition

Confirm that the selected project or checkout points at a root containing the updated `t3.json`.
Existing saved Actions do not update just because the file changed. Reload LastCode after updating
the persistent project root, then reopen the import menu.

### The agent runs the command directly

Update the workflow instructions to require `list_project_actions`,
`run_project_action_and_resume`, and an immediate end to the turn. Remove stale instructions that
prescribe the direct command. Direct execution should be a reported fallback, not a parallel normal
path.

### Computer use is unavailable

The agent can still finish the command, `t3.json`, tests, and workflow instructions. It should then
report the exact remaining UI steps and leave the Action disabled until a user or a later authorized
agent completes them. It should not claim that resumable execution was verified.
