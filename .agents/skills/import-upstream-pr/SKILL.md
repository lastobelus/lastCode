---
name: import-upstream-pr
description: Evaluate, port, validate, and deliver an open-unmerged or closed-unmerged pingdotgg/t3code pull request into LastCode while preserving exact upstream provenance. Use when LastCode wants an existing upstream PR before it merges, after it closes without merge, or when re-evaluating a force-pushed upstream candidate. Do not use to author a new upstream contribution; use upstream-fix. Do not use for a fork-only change with no upstream PR; use lastcode-pr.
---

# Import Upstream PR

Adopt one existing T3 Code PR as an independently owned LastCode change. Treat
the upstream PR as a pinned candidate and evidence source, never as a substitute
for LastCode review, validation, or merge authority.

## Establish the Boundary

1. Read the repository `AGENTS.md` and `docs/lastcode/fork-conventions.md`.
2. Read [references/intake-and-evidence.md](references/intake-and-evidence.md)
   before capturing the candidate.
3. Keep the product port separate from notes, workflow documentation, and skill
   changes. Use separate branches or worktrees.
4. Do not infer permission to push, open a PR, use a browser, or merge. Obtain
   the authority required by the repository instructions for each operation.

## Pin and Inspect the Candidate

1. Capture the upstream PR URL, state, observed date, title, author, base, exact
   `headRefOid`, ordered commits, changed files, checks, reviews, review threads,
   linked issues, and closure reason when closed.
2. Force-fetch `pull/<number>/head` into a dedicated remote-tracking ref so a
   previously cached ref cannot reject a legitimate upstream force-push.
   Require the fetched SHA to equal the captured `headRefOid`. Never import a
   moving branch name.
3. Derive the complete, oldest-first commit list from the pinned base and head
   Git objects. Record its count and require its final SHA to equal
   `headRefOid`. Do not use GitHub's PR commits response as the source of truth;
   that endpoint is capped at 250 commits even when paginated.
4. Inspect metadata and the full diff before installing dependencies or running
   any code controlled by the PR.
5. Check current `upstream/main` and `origin/lastcode/main` for the same behavior,
   a replacement, or an incompatible design.
6. Treat a force-pushed upstream head as a new candidate. Range-diff it against
   the prior pinned head and repeat the applicable review and validation.

If `origin/lastcode/main` already contains the exact behavior or an accepted
replacement, stop before creating an evaluation branch and report the candidate
as already adopted or superseded. If only `upstream/main` contains it, decide
whether normal nightly reconciliation is sufficient before creating a manual
port.

## Decide Eligibility

- For an open, unmerged PR, decide whether LastCode benefits enough to adopt it
  now instead of waiting.
- For a closed, unmerged PR, establish why it closed. Inactivity, contribution
  policy, or maintainer bandwidth can be acceptable. Incorrectness,
  supersession, or rejected direction requires an explicit LastCode divergence
  decision.
- Pause for hidden dependencies, unresolved correctness findings, unclear
  product value, unexplained closure, or scope too large to validate
  proportionally.

Record the adoption decision. Upstream CI is supporting evidence only.

## Build an Isolated Evaluation

1. Fetch `origin` with pruning and create a clean worktree on
   `pr/upstream/<number>-<slug>` from the exact `origin/lastcode/main`.
2. Apply the pinned Git graph's ordered commit list with `git cherry-pick -x`.
   Preserve authorship and commit boundaries when the stack is coherent. If
   the range contains merge commits, stop and plan an ancestry-aware import or
   a reimplementation instead of flattening it blindly.
3. Do not merge the upstream PR branch; that drags its base history into
   LastCode.
4. If the stack does not fit current LastCode, reimplement only the coherent
   behavior and record the upstream PR URL, pinned SHA, and why cherry-pick was
   unsuitable.

Classify integration honestly:

- changed-path overlap is a risk signal, not a conflict;
- a clean auto-merge still needs semantic review in current LastCode context;
- a textual conflict requires explicit resolution review;
- a clean textual application can still have a semantic conflict.

Treat every conflict resolution and downstream adaptation as first-party code.

## Validate the Port

1. Review every changed line against current LastCode and the linked problem.
2. Walk the affected entry points, clients, providers, contracts, reverse
   states, connection modes, performance concerns, and docs. Mark each
   non-applicable surface explicitly.
3. Complete dependency installation before starting checks. A partially
   completed install is not evidence; require its zero exit and terminal
   completion.
4. Run focused behavior tests, targeted lint, the affected package typecheck,
   and `git diff --check <destination-base> <port-head>` under the repository's
   canonical toolchain. A bare `git diff --check` does not inspect an already
   committed port. Record the toolchain command and versions with the receipt.
5. Add focused regression tests for backend or automation behavior. Do not run
   repo-wide checks merely for intake.
6. For user-visible behavior, obtain browser/computer-use approval and use the
   applicable repository app-testing skill against disposable state. Capture
   matched LastCode-specific before/after evidence and identify the real client,
   viewport, and any authorized fallback accurately.
7. Keep one live app tab when shared browser storage can make cross-tab state
   nondeterministic. Verify route, persisted state, and rendered state rather
   than trusting a click result alone.

When accepted, rename the branch to `port/upstream/pr-<number>-<slug>`.

## Refresh and Deliver

1. Immediately before delivery, fetch `origin/lastcode/main` again. If the port
   parent moved, rebase the imported commits and rerun affected validation.
2. Before the guarded push, require a clean worktree and record the local head,
   destination base, and existing remote topic SHA (or its absence). Then push
   in a clean environment so the pre-push `pnpm lastcode:ci:quick` gate sees
   ordinary Git/SSH variables. Do not export `GIT_SSH_COMMAND` or inject an SSH
   command through Git configuration around the push; those settings flow into
   tests that intentionally control `GIT_SSH`.
3. If Quick CI passes but the idle SSH transport subsequently dies, do not
   treat its generic success line as an exact-head receipt. Require the local
   head to equal the recorded head, the worktree to remain clean, the fetched
   destination base to equal the recorded base, and the remote topic SHA (or
   absence) to remain unchanged. Only then retry that recorded head with
   `--no-verify` and an exact `--force-with-lease` tied to the recorded remote
   topic state. Otherwise rerun the guarded push and its hook.
4. Open a PR targeting `lastcode/main` only when explicitly requested. Include
   the upstream PR and pinned head, observed state/date, import method,
   adaptations, rationale, validation, closure/review context, and published
   evidence.
5. For review and merge, follow `lastcode-pr` and
   `.agents/skills/_references/external-review-mechanics.md`: require a terminal
   clean Codex result for the exact head, zero unresolved threads, and a full
   `pnpm lastcode:ci` stamp for the exact head/current base. Merge only through
   `pnpm lastcode:merge`.
6. Verify the merged commit on `origin/lastcode/main`. For a squash merge,
   compare stable patch IDs so provenance verification does not depend on the
   topic commit remaining an ancestor.

## Reconcile Later Upstream Movement

- If upstream later merges an identical patch, let normal nightly reconciliation
  remove the duplicate.
- If upstream merges a changed version, compare it with the pinned imported head
  and port only the desired delta.
- If upstream closes unmerged, retain or remove the behavior according to
  LastCode's product decision, not the state transition alone.
- Preserve the upstream URL and pinned SHA in the LastCode PR so future sync work
  can explain the source.

## Handoff

Report the source PR state and pinned head, destination base and port head,
import method and adaptations, validation and real-client evidence, PR/merge
state, exact-head review result, unresolved-thread count, full-CI stamp, and the
merged commit or remaining blocker.
