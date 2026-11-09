---
name: lastcode-pr
description: Deliver a LastCode change through its branch, Quick CI, GitHub CI, Codex review, and guarded merge workflow. Default delivery path for all LastCode work, including general T3 Code fixes and improvements, Markover integration, branding, personal conveniences, checkpointing, and releases. Use upstream-fix only when the user specifically requests an upstream contribution.
---

# LastCode PR

Ship LastCode work from the canonical downstream base without contaminating the
clean upstream mirror.

When `scripts/lastcode-carry-set.json` enables carry replay, prepare source
commits using the ownership and provenance rules in
`docs/lastcode/nightly-workflow.md#carry-replay-ownership` before validation
and review. A PR may contain several groups; each source commit has one owner.

## Keep Upstream References Quiet

When a fork change derives from an upstream PR or issue, preserve the upstream
repository and number, plus any existing pinned SHA or other hash, in the PR
body and in every new commit message that carries the provenance, including
the final squash message. Use
`https://redirect.github.com/<owner>/<repo>/pull/<number>` (or `/issues/<number>`)
for published cross-repository links. Ordinary GitHub
links and `owner/repo#number` shorthand create backlinks; replaying downstream
commits during checkpoint rebases repeats those entries and can spam the
upstream PR. Keep canonical GitHub URLs for API and `gh` targets and Git
operations. Before merging, inspect the current PR body because
the guarded wrapper derives the squash message from it. Do not rewrite
existing historical commits or immutable checkpoint tags solely to change
links.

## Classify and Branch

Read `docs/lastcode/fork-conventions.md` and the repository `AGENTS.md` first.
This is the default path, including for general fixes, and a generic PR request
means a LastCode PR. Switch to `upstream-fix` only when the user specifically
asks for an upstream contribution; never pause to ask whether to go upstream.

1. Ensure the worktree is clean and fetch `origin` with pruning.
2. Create `lastcode/markover/<topic>` for Markover integration or
   `lastcode/<topic>` for other LastCode work from the exact
   `origin/lastcode/main`.
3. Keep one concern per branch and PR. Put LastCode-only contributor and
   operations documentation under the fork's deliberate `docs/lastcode/`
   namespace. Keep product and upstream-facing documentation in the
   audience-based directories required by `AGENTS.md`.
4. Never target `main` or `pingdotgg/t3code` from this workflow.

## Implement and Validate

1. Implement the smallest complete change, including focused regression tests
   for backend or automation behavior. [Build repairs](#build-repairs) skip
   the new tests.
2. Run the smallest relevant tests and lint required by `AGENTS.md`. Use the
   Quick CI policy below for workspace typechecks; do not recreate a deferred
   local gate with parallel TypeScript processes.
3. Rebase onto the latest `origin/lastcode/main` before publishing.
4. Local Quick CI is optional; GitHub CI remains required. In the default
   Automatic mode, run the independent **Run Quick CI** Project Action. It uses
   free local capacity immediately or defers to GitHub without queuing. After
   resume, verify the exact clean head and workstream base. Launch it only from
   the clean exact checkout being validated: a shell's working directory and a
   `--pr` gate check don't change the saved Action's checkout. Prefer the
   repository-managed `lc-local-ci` over the older saved `run-quick-ci` if both
   exist, and never run Quick CI synchronously as a fallback. A local pass needs
   a receipt matching the head, base ref, base commit and Quick-gate version, and
   records a reusable receipt; a `validation: github-only` result permits publishing but
   is not a local pass. In GitHub-only mode, publish without requiring the local
   Action. The ordinary pre-push hook follows the same policy; keep it enabled.
   Always local mode waits for capacity, and `--require-local` explicitly forces
   local Quick CI. Settings → LastCode → Local CI selects the mode. A delegated
   child task hands this and every other Action in this workflow to its parent
   unless its brief says it owns its Actions;
   see [Parent-mediated Actions](../../../docs/internals/resumable-project-actions-setup.md#parent-mediated-actions-for-delegated-children).
5. Open a PR targeting `lastcode/main` only when the user explicitly asks.

For an explicitly requested stack, a child may instead branch from and target
its same-repository parent PR, whose chain must lead to `lastcode/main`. Follow
[Sequential Stack Babysitting](../_references/stacked-pr-babysit.md) for target
selection and ordered delivery. The ordinary instruction to rebase onto main
does not flatten an unmerged stack: preserve the parent until it lands, then
restack the child and refresh validation. Quick CI still uses the canonical
workstream base, not the parent branch.

Open PRs do not pause checkpoint creation, repaired-checkpoint publication, or
promotion to `lastcode/main`. Never close, merge, or retarget an unrelated PR to
unblock checkpoints. A candidate must incorporate its pinned source, and its
promotion lease must protect that source against concurrent merges. Merging
while a checkpoint prepares is safe: the validated tag still publishes and
promotion defers if main advances. Ordinary merges request no checkpoint.
`--skip-checkpoint` makes that default explicit; use `--checkpoint` only when
the user separately authorizes an extra service run. It starts the service
from this checkout, which needs installed dependencies. A dependency request or
permission to merge does not authorize one. New merged work belongs to a later
admitted batch, without automatically revising the selected release.
A repaired recovery retains its exact selection and worktree until promotion
is confirmed; deferred promotion does not authorize cleanup or a successor.

Failure to acquire the promotion lock still fails the run after tag publication.
Inspect its owner and the connection error before retrying; a lock ref alone
does not prove an active merge.

A PR behind `lastcode/main` merges without a rebase or new CI once CI passed
on its head: GitHub no longer requires branches to be up to date, and
`lastcode:merge` checks the PR against the current tip itself. Rebase and push
only when the merge reports a conflict, a carry failure, or a tested base that a
checkpoint rewrote. If main moves while the merge runs, run it again.

## Build Repairs

A build repair is a PR whose only purpose is making a failed checkpoint,
revision, or Intel package build pass. Upstream moves fast, so most builds need
one. Its goal is a published package, not a complete fix.

- Make the smallest change that gets the failing step through. Raising a
  timeout that only the build host exceeds, or quarantining a test that fails
  only there, is acceptable. Add no regression tests or hardening beyond the
  failure.
- Fix only review findings that would break the build or the product. Dismiss
  the rest with a one-line reason such as "hardening; out of scope for a build
  repair", then merge when the gates pass.
- If unrelated tooling breaks along the way, mention it and keep going on the
  build.

All other PRs keep the full workflow in this skill.

## Babysit and Merge

An app-owned delegated child uses this watch workflow only when its parent's brief verifies `features.appOwnedPullRequestWatchContinuationVersion` and #482 Phase 4 acceptance of the destination's installed checkpoint, or authorizes a narrow isolated acceptance scenario. Otherwise the child reports an unfinished PR handoff and its parent owns the watch. Parent-mediated waits stay with their recorded owner. Owning a watch leaves merge authority and the exact-head and base gates unchanged.

Use this workflow whenever the authorized task includes waiting for a LastCode
PR's checks or review, including PRs created while repairing checkpoint or build
failures. The user does not need to say “babysit.” Creating a PR alone does not
authorize merging it; preserve the requested stopping point.

Read `.agents/skills/_references/external-review-mechanics.md` for the repository's
current GitHub thread and review-query mechanics.

1. Inspect comments and thread-level review state newer than the latest push.
2. Verify each bot finding against the source. Fix real defects; reply with a
   concrete reason when a finding is false. Resolve only addressed threads.
   When rejecting a top-level issue-comment or body-only formal finding without
   pushing a fix or resolving an inline thread, post the exact handled marker
   documented in the external-review reference before rerunning the gate check.
3. After each fix push, request review using the exact-head format in
   `../_references/external-review-mechanics.md`. Do not merge until Codex gives
   an explicit clean result or every finding for the exact current head has a
   durable handled state, and no review thread remains unresolved.
4. While exact-head GitHub CI or Codex review is passive and no current finding
   needs judgement, wait as the global `babysit` skill's Wait section says: call
   `watch_pull_request` with the PR's explicit URL, then run
   `pnpm --config.verify-deps-before-run=false lastcode:pr-gates` once (add `--pr PR_NUMBER` for a
   stack or a PR outside a clean matching checkout), and on `pending` end the
   turn. The check and the merge need only Node, `git` and `gh`, so run them in
   a checkout without `node_modules`; the flag stops pnpm from installing
   dependencies first. Do not poll GitHub, sleep, or start a polling Action or
   watcher. On each wake, rerun the check and fix actionable failures or
   findings even while another gate is pending; otherwise end the turn and let
   the watch continue. Call `unwatch_pull_request` before handing the work back.

   Act on the check's `attention` reasons:
   - `observation-failed` (a GitHub read failed, or the PR or evidence changed
     during the check) or `mergeability-unknown`: rerun the check once, and
     report the blocker if it persists.
   - `review-stalled`: the newest exact-head review request is older than the
     quiet deadline in Settings → LastCode (45 minutes by default), even if
     Codex reacted with eyes. Report it as a blocker. It is not approval, and it
     permits no merge, second review request, or substitute review.
   - `ci-not-registered`: no CI run registered, so nothing can wake the watch.
     Report it as a blocker. A base that moved without a push starts no run;
     otherwise check the workflow trigger and Actions configuration.

   The watch also wakes once when the PR has been quiet for that deadline. Run
   the check and act on what it reports. If it is still `pending`, report the
   expired wait and what is still pending as a blocker, then call
   `unwatch_pull_request`; ending the turn instead can wait forever. Watch again
   only when the user asks you to keep waiting or new actionable work needs it.

5. Merge with `pnpm --config.verify-deps-before-run=false lastcode:merge` from the PR's
   own checkout; do not bypass the guarded merge in the GitHub UI.
   The wrapper independently revalidates a successful exact-head/base GitHub CI
   run and aggregate `CI Gate`, strict exact-head review readiness with zero
   unresolved review threads, a clean current PR that merges without conflicts
   onto the current tip, carry groups recompiled against that tip, and an
   unchanged fetched base under the shared remote main-write lock immediately
   before its exact-head squash merge. Checkpoint promotion uses the same lock; open PRs and CI waits
   never hold it. Use the updated guarded command rather than the GitHub UI or
   old worktree scripts, which do not participate in this coordination. Preserve
   an uncertain remote lock until its owner and operation outcome are verified.
6. Verify the PR is merged and `origin/lastcode/main` contains the merge commit
   the wrapper prints. Then confirm main's push CI for that commit: a PR merged
   behind main is first tested as merged there. Find the run with the
   `gh run list` command the wrapper prints, start
   `gh run watch RUN_ID --repo lastobelus/lastCode --exit-status --interval 60`
   as a background command whose exit wakes you, finish cleanup, and end the
   turn. `watch_pull_request` cannot see this run. If your harness cannot wake
   on a background command, keep the turn open on that command instead. If the
   run fails, compare it with the previous main run. When your merge caused it,
   alone or together with a concurrent merge, open a fix-forward PR at once, or
   a revert PR if no quick fix exists. When it did not, rerun the failed jobs
   once and report it. Ordinary PRs have no Full CI action or local Full-CI
   stamp; checkpoint and release Full CI are a separate workflow.
   For a whole-stack merge request, restack and validate the next authorized
   member using the stack reference; one merged PR does not finish the request.
7. If the work is tracked by Markover, confirm the GitHub terminal state and
   run the service-free command from the Markover checkout:

   ```bash
   npm --silent run markover -- done <pr-url> --pr-status merged
   ```

One immediate status snapshot can establish that a wait is needed. For this
LastCode workflow, the native PR watch owns subsequent passive checks; the
general repository CI polling rule does not require agent-side sleeps or
repeated queries. Stop at the requested ready/merged state or a real blocker.

Do not build or install an Intel package after merge unless the user asks for
an Intel update separately. Then use the **Build Intel package (macOS)** Project
Action for the merged change's exact installable tag, and leave installation or
restart as a later explicit decision.

## Handoff

Report the PR URL, merged commit or current head, focused and GitHub CI validation,
Codex review result, unresolved-thread count, and Markover state when applicable.
If no PR was requested, report the local branch and commit without publishing it.
