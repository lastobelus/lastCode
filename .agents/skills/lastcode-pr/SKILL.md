---
name: lastcode-pr
description: Deliver a LastCode-only change through its branch, local CI, Codex review, and guarded merge workflow. Use for Markover integration, LastCode identity or branding, personal conveniences, nightly checkpointing, ad-hoc releases, and any change intentionally not proposed to pingdotgg/t3code. Use upstream-fix instead when a general improvement should also be offered upstream.
---

# LastCode PR

Ship fork-only work from the canonical downstream base without contaminating the
clean upstream mirror.

## Classify and Branch

Read `docs/lastcode/fork-conventions.md` and the repository `AGENTS.md` first.
If the change makes sense to a T3 Code user without LastCode or Markover context
and should be proposed upstream, switch to `upstream-fix`.

1. Ensure the worktree is clean and fetch `origin` with pruning.
2. Create `lastcode/markover/<topic>` for Markover integration or
   `lastcode/<topic>` for other fork-only work from the exact
   `origin/lastcode/main`.
3. Keep one concern per branch and PR. Put LastCode-only contributor and
   operations documentation under the fork's deliberate `docs/lastcode/`
   namespace. Keep product and upstream-facing documentation in the
   audience-based directories required by `AGENTS.md`.
4. Never target `main` or `pingdotgg/t3code` from this workflow.

## Implement and Validate

1. Implement the smallest complete change, including focused regression tests
   for backend or automation behavior.
2. Run the smallest relevant tests, lint, and typecheck required by `AGENTS.md`.
3. Rebase onto the latest `origin/lastcode/main` before publishing.
4. Push the branch; the pre-push hook must pass `pnpm lastcode:ci:quick` locally.
5. Open a PR targeting `lastcode/main` only when the user explicitly asks.

An open PR targeting `lastcode/main` pauses promotion of a new nightly onto the
branch. Checkpoint automation still publishes every immutable nightly tag and
promotes the newest one after the PR queue is empty.

## Babysit and Merge

When the user asks to babysit or merge:

Read `.agents/skills/_references/external-review-mechanics.md` for the repository's
current GitHub thread and review-query mechanics.

1. Inspect comments and thread-level review state newer than the latest push.
2. Verify each bot finding against the source. Fix real defects; reply with a
   concrete reason when a finding is false. Resolve only addressed threads.
   When rejecting a top-level issue-comment or body-only formal finding without
   pushing a fix or resolving an inline thread, post the exact handled marker
   documented in the external-review reference before relaunching `Wait for PR`.
3. After each fix push, request review using the exact-head format in
   `../_references/external-review-mechanics.md`. Do not merge until Codex gives
   an explicit clean result or every finding for the exact current head has a
   durable handled state, and no review thread remains unresolved.
4. Run `pnpm lastcode:ci` from a clean branch. Its full-CI stamp must match the
   exact head and fetched `origin/lastcode/main` base.
5. Use `pnpm lastcode:merge`; do not bypass the guarded merge in the GitHub UI.
6. Verify the PR is merged and `origin/lastcode/main` contains the merge result.
7. If the work is tracked by Markover, confirm the GitHub terminal state and
   run the service-free command from the Markover checkout:

   ```bash
   npm --silent run markover -- done <pr-url> --pr-status merged
   ```

Follow the repository's bounded CI polling rule. Stay quiet when no new review
or check result exists, and stop only when the latest commit is clean or a real
external blocker requires the user.

## Handoff

Report the PR URL, merged commit or current head, focused and full validation,
Codex review result, unresolved-thread count, and Markover state when applicable.
If no PR was requested, report the local branch and commit without publishing it.
