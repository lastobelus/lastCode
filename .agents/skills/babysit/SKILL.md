---
name: babysit
description: Babysit a LastCode pull request or an identified stack through CI and review, and merge in dependency order when explicitly requested. Also use for passive PR waits during authorized repair work. Do not use for upstream T3 Code pull requests or other repositories.
---

# LastCode Babysit

Keep a LastCode PR or stack moving without spending agent turns on passive
validation, GitHub CI, or Codex review. **Babysit** stops when the requested
members pass their current-base gates; **babysit and merge** also carries every
authorized member into `lastcode/main` through the guarded merge. A child that
passes against its parent is stack-validated, not ready for a final merge.

Use the passive-wait handoff whenever authorized LastCode PR work reaches CI or
review waiting, even if the user did not say “babysit.” Preserve the requested
stopping point; this does not authorize creating or merging a PR.

## Establish the Boundary

Read the repository `AGENTS.md`, `.agents/skills/lastcode-pr/SKILL.md`, and
`.agents/skills/_references/external-review-mechanics.md` before acting. Those
documents are authoritative for focused validation, review mechanics, Project
Actions, and guarded merge requirements.

Resolve the requested PRs and stopping point. A LastCode PR must target
`lastcode/main` or have a same-repository parent chain leading there. Do not use
this skill for an upstream PR, a PR against `main`, or another repository.
Do not create a PR unless the user separately asks. For a stack, read
[_references/stacked-pr-babysit.md](../_references/stacked-pr-babysit.md) before
preparing the first target; it defines membership, sequential waits, and
restacking after squash merges.

At the start of every turn, including a PR-watch wake or action-resumed turn,
take one fresh snapshot of the local branch and worktree plus the PR head, base,
mergeability, checks, formal reviews, issue comments, and every review thread.
Bind every result to the exact head and base. Never treat an older gate-check
result, action result, review, or workflow run as evidence for a changed
revision.
If an already-known pending continuation requires this turn to end, follow
**Handle an Unavailable Action** first; do not take another PR snapshot merely
to repeat that blocker.

## Keep Judgement in the Agent

Before running the gate check or starting a watch, handle every artifact
already present:

1. Verify each finding against the current source and diff.
2. Fix real defects, run focused validation, and commit the intended change.
   Do not reply to or resolve a fix-related finding until that commit has been
   successfully pushed to the PR.
3. Reply with concrete evidence to disproved findings and resolve only
   disproved threads. When rejecting a top-level or body-only finding without a
   fix push, post the exact handled marker required by the external-review
   reference.
4. Decide whether a failed gate merits a fix, rebase, GitHub retry, or no retry.
   The gate check, PR watch, and Actions only observe or execute one bounded
   operation; they do not make these decisions.

A dirty worktree invalidates local validation and merge eligibility. A new
commit, amend, rebase, changed PR head, or changed base invalidates the relevant
revision-bound results. A `--pr` gate check reads remote state only and is
independent of unrelated edits in the coordinator's checkout. Re-snapshot and
repeat only the gates that apply to the new revision.

## Handle an Unavailable Action

Use the actual `disabledReason` from `list_project_actions`. An automated
message does not by itself prevent another resumable Action.

If it says **“This thread must finish its current Action continuation first,”**
an earlier Action is still running, awaiting delivery, or has an interrupted
follow-up. A maintenance alert or resolution notice can start a turn before an
Action result is delivered. When that result is running or queued, preserve the
next step in a short closing message and **end the turn immediately** so the
existing follow-up can arrive. After it arrives, inspect its result and list
Actions again before launching the next gate. Do not run Quick CI or Full CI
directly, poll, ask for import/permission changes, or start a replacement turn
to get around this guard. If the known retained follow-up is
interrupted and requires Resume, report that specific blocker instead of
promising automatic delivery.

A succeeded process with a pending follow-up still owns the continuation slot.
An incoming user turn does not release it. Keep one resumable Action at a time
for the whole stack; neither duplicate launches nor manual polling releases it.

If the Action is absent or its reason says it has not been opted in, report the
specific import or resume-permission setup needed. For another disabled reason,
report that reason. Unavailability never authorizes a synchronous gate fallback.

## Validate and Publish

After focused validation and once the intended changes are committed on a clean
worktree, local Quick CI is optional and GitHub CI is required. Automatic mode
uses free local capacity or defers to GitHub without waiting. Always local mode
queues; GitHub-only mode permits publishing without the Quick Action. Do not
replace a deferral with direct parallel workspace typechecks. When using the
independent Quick Action:

1. Require this thread's Action checkout to be the clean exact checkout being
   validated, then list Project Actions. A shell command's working directory
   does not change the saved Action's checkout. A `--pr` gate check does not
   redirect Quick CI.
2. Select the eligible `Run Quick CI` action by its returned stable ID. Prefer
   repository-managed `lc-local-ci` over the older saved `run-quick-ci` if both
   exist.
3. Launch it with `run_project_action_and_resume` and end the turn immediately.
   Do not inspect its process or run another command after launch.

If that action is absent or ineligible, follow **Handle an Unavailable Action**
above. Do not run it synchronously as an agent fallback.

After the action resumes, verify its identity against the current clean head and
selected workstream base commit. A local pass must have a receipt matching the
head, base ref, base commit, and Quick-gate version. An attention result with
`validation: github-only` permits publishing for required GitHub validation; it
does not count as a local pass or produce a receipt. If any identity changed,
discard the result and re-evaluate. The agent then decides whether and what to
push. The pre-push hook reuses a matching receipt or follows the selected mode.

After a successful fixing push, reply to each addressed finding with evidence
from the new head and resolve only those addressed threads. Request review only
after that durable review state matches the code now on the PR.

For a transport-only retry, reuse the receipt only if the local head, worktree,
base, and remote topic state are unchanged. Otherwise re-evaluate the Quick CI
policy against the current revision. Never use
`--no-verify` as the ordinary agent push path.

## Wait for Remote Gates

After each push, request Codex review unless an exact-head request is already
active, using exactly:

```text
@codex review
<!-- lastcode-review-head: HEAD_SHA -->
```

The native PR watch (`watch_pull_request`) is the only thing that waits on
GitHub for this thread. Do not run a polling Action, background watcher, sleep
loop, or repeated GitHub queries.

When exact-head GitHub CI or Codex review is passive and no current artifact
needs judgement:

1. Handle current findings and request exact-head review first. The watch only
   wakes for comments posted after it starts.
2. Run the one-shot gate check: `pnpm lastcode:pr-gates` in a clean checkout
   whose `HEAD` is the PR head, or `pnpm lastcode:pr-gates --pr PR_NUMBER` from
   any checkout. It takes one GitHub snapshot, confirming identity and
   evidence with a second read, and prints one JSON decision with the
   PR/head/base identity, CI evidence, review state, unresolved-thread count,
   and parent chain. It exits non-zero only for `attention`. It never waits,
   approves, or merges.
3. On `attention`, act on its reason now. For `observation-failed` (a GitHub
   read failed, or the PR or evidence changed during the check), rerun the
   check once; report the blocker if it persists. On `ready` or `stacked-ready`, continue
   to the finish line below. On `pending`, call `watch_pull_request` with the
   PR's explicit URL and end the turn. For a stack, follow the
   [stack reference](../_references/stacked-pr-babysit.md#check-and-watch-stack-members).

On every wake, take the fresh snapshot above and run the gate check again. A
wake is news, not a verdict: the watch also wakes when required checks pass
while review is still pending, when a bot edits a remark, and when someone
reacts to your comment (Codex's eyes reaction only means review started). The
first wake after a watch starts can also report reactions that already existed. Fix an
actionable CI failure or finding immediately, even while another gate is still
pending. When the check is still `pending` and nothing needs action, end the
turn; the watch continues. If the watch has ended (for example after repeated
comment-only wakes) while the PR is still pending, start it again.

The watch has no review timeout, so a review request that Codex never answers
does not wake the thread. Requesting review before ending the turn keeps the
normal wake path in place. When a later snapshot shows review still missing,
treat it as a blocker to handle rather than waiting again. A CI run that never
registers cannot wake the watch either, so the check reports it as `pending`
only while review is pending and as `ci-not-registered` attention otherwise. A
base that moved without a push starts no run; otherwise check the workflow
trigger and Actions configuration.

A `stacked-ready` result means validation against the current parent, not
permission to merge into main. If `watch_pull_request` is unavailable, report
that blocker; do not poll manually. A subagent cannot watch a PR; it reports the
pending state and next step to the parent thread that owns the watch.

## Finish the Requested Mode

Before finishing, take a fresh snapshot and require all of these on the same
exact head and base:

- a `ready` gate check, or `stacked-ready` for a child reported only as
  validated against its parent;
- terminal-clean Codex review or durable handled evidence for every finding;
- zero unresolved review threads, including outdated threads;
- one successful exact GitHub workflow run and aggregate `CI Gate`;
- clean mergeability and an unchanged expected base; and
- for final merge, a clean local worktree whose `HEAD` equals the PR head and
  whose PR base is current `lastcode/main`.

There is no ordinary-PR Full CI action or local Full-CI stamp. Comprehensive PR
coverage and merge authority live in GitHub CI; checkpoint and release Full CI
remain a separate workflow outside this skill.

For **babysit**, report the exact revision and final review, thread, CI, and
mergeability state for every requested member. Identify children validated
against a parent separately from members ready for main. Do not merge.

For **babysit and merge**, run `pnpm lastcode:merge`. Do not merge in the GitHub
UI. The guard independently rereads exact GitHub CI, strict exact-head review
readiness, and unresolved review threads, refetches the base, and checks the
clean PR immediately before its exact-head squash merge. Verify that
the PR merged, the merged tree matches the reviewed head, and
`origin/lastcode/main` contains the result. Complete tracked-work bookkeeping
required by `lastcode-pr`.

For a stack, continue with the next authorized member using the stack reference;
merging one member does not finish a whole-stack request.

Call `unwatch_pull_request` for every watched PR when the requested work
finishes or you hand the work back for a blocker or decision, so the thread
returns to the user's inbox.

Stop and report a real blocker when a gate fails, a finding needs a user
decision, or the exact head/base cannot satisfy the guarded merge requirements.

## Separate Intel Update Work

Do not automatically build or install an Intel package after merge. If the user
separately requests an Intel update and the merged server change has an exact
installable tag, select that tag and use the independent **Build Intel package
(macOS)** Project Action. End the turn after launching it, inspect its immutable
tag/commit result after resume, and leave installation or restart as a later
explicit decision.
