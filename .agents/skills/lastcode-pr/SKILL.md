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
operations. Before `pnpm lastcode:merge`, inspect the current PR body because
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
   for backend or automation behavior.
2. Run the smallest relevant tests and lint required by `AGENTS.md`. Use the
   Quick CI policy below for workspace typechecks; do not recreate a deferred
   local gate with parallel TypeScript processes.
3. Rebase onto the latest `origin/lastcode/main` before publishing.
4. Local Quick CI is optional; GitHub CI remains required. In the default
   Automatic mode, run the independent **Run Quick CI** Project Action. It uses
   free local capacity immediately or defers to GitHub without queuing. After
   resume, verify the exact clean head and workstream base. A local pass records
   a reusable receipt; a `validation: github-only` result permits publishing but
   is not a local pass. In GitHub-only mode, publish without requiring the local
   Action. The ordinary pre-push hook follows the same policy; keep it enabled.
   Always local mode waits for capacity, and `--require-local` explicitly forces
   local Quick CI. Settings → LastCode → Local CI selects the mode.
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
the user separately authorizes an extra service run. A dependency request or
permission to merge does not authorize one. New merged work belongs to a later
admitted batch, without automatically revising the selected release.
A repaired recovery retains its exact selection and worktree until promotion
is confirmed; deferred promotion does not authorize cleanup or a successor.

Failure to acquire the promotion lock still fails the run after tag publication.
Inspect its owner and the connection error before retrying; a lock ref alone
does not prove an active merge.

When `lastcode/main` advances, obtain fresh validation against the new base
before merging. Refresh the PR branch as needed; validation from the previous
base does not remain valid merely because the PR head is unchanged.

## Babysit and Merge

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
   needs judgement, follow the babysit skill's
   [Wait for Remote Gates](../babysit/SKILL.md#wait-for-remote-gates): call
   `watch_pull_request` with the PR's explicit URL, then run
   `pnpm lastcode:pr-gates` once (add `--pr PR_NUMBER` for a stack or a PR
   outside a clean matching checkout), and on `pending` end the turn. Do not
   poll GitHub, sleep, or start a polling Action or watcher. On each wake,
   rerun the check and fix actionable failures or findings even while another
   gate is pending; otherwise end the turn and let the watch continue. Call
   `unwatch_pull_request` before handing the work back.
5. Use `pnpm lastcode:merge`; do not bypass the guarded merge in the GitHub UI.
   The wrapper independently revalidates a successful exact-head/base GitHub CI
   run and aggregate `CI Gate`, strict exact-head review readiness with zero
   unresolved review threads, a clean current PR, and an unchanged fetched
   base under the shared remote main-write lock immediately before its exact-head
   squash merge. Checkpoint promotion uses the same lock; open PRs and CI waits
   never hold it. Use the updated guarded command rather than the GitHub UI or
   old worktree scripts, which do not participate in this coordination. Preserve
   an uncertain remote lock until its owner and operation outcome are verified.
6. Verify the PR is merged and `origin/lastcode/main` contains the merge result.
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

## Handoff

Report the PR URL, merged commit or current head, focused and GitHub CI validation,
Codex review result, unresolved-thread count, and Markover state when applicable.
If no PR was requested, report the local branch and commit without publishing it.
