---
name: upstream-fix
description: Prepare and deliver an explicitly requested upstream contribution to pingdotgg/t3code while LastCode retains an independent copy. Use only when the user specifically asks for an upstream PR or contribution. General fixes and generic PR requests use lastcode-pr; importing an existing upstream PR uses import-upstream-pr.
---

# Upstream Fix

Deliver a requested upstream improvement through two independent branches: an
upstream-pure contribution and a LastCode port. Keep their bases, reviews, CI,
and merge decisions separate.

## Confirm the Request

Use this workflow only when the user specifically asks for an upstream PR or
contribution. General usefulness, a generic fix or PR request, and a plan's
paired-delivery steps are not that request; continue those through
`lastcode-pr` without asking about upstream.

The upstream change must make sense to a T3 Code user with no LastCode or
Markover context. Keep fork identity, Markover integration, personal
conveniences, nightly automation, and local release machinery in LastCode.

Read `docs/lastcode/fork-conventions.md` before changing branches. Follow the
repository `AGENTS.md` on both branches.

## Prepare the Upstream Delivery

1. Ensure the worktree is clean. Fetch `upstream` and `origin` with pruning.
2. Confirm `upstream` is `pingdotgg/t3code` and `origin` is the writable fork.
3. Fast-forward the fork mirror with `git push origin upstream/main:main`. If it
   is not a fast-forward, stop and inspect; never merge or force downstream
   history into `main`.
4. Create `fix/<topic>` or `feat/<topic>` from the exact fetched
   `upstream/main`, not from `lastcode/main`.
5. Implement one upstream concern. Exclude LastCode branding, Markover details,
   downstream automation, and `docs/lastcode` changes.
6. Run the smallest relevant tests and checks required by `AGENTS.md`.
7. Fetch and rebase onto the latest `upstream/main` immediately before opening
   the PR. Push to `origin` and target `pingdotgg/t3code:main`.
8. Follow upstream CI and review conventions. Verify review findings against the
   source, address real issues, and explain false positives.

Open the upstream PR only when the user asked for it; a LastCode PR request
does not count.

## Prepare the LastCode Delivery

1. Fetch `origin` again and create `port/upstream/<topic>` from the exact
   `origin/lastcode/main`.
2. Cherry-pick the upstream change when clean; otherwise reimplement the same
   behavior against LastCode without dragging in unrelated upstream history.
3. Preserve any LastCode-specific adaptation only on this branch.
   When carry replay is enabled, assign the LastCode source commits and record
   upstream provenance using
   `docs/lastcode/nightly-workflow.md#carry-replay-ownership` before validation
   and review. These trailers belong only on the LastCode delivery.
4. Run focused local validation and follow `lastcode-pr` for optional local Quick
   CI. GitHub CI is required only for a requested LastCode PR. The pre-push hook
   follows the configured mode.
5. Open the LastCode PR only when the user also asks for it. Otherwise keep the
   validated port local and report it. Target `lastobelus/lastCode:lastcode/main`
   and link the upstream PR in both descriptions.
6. Before merge, require a current-head clean Codex review, zero unresolved
   review threads, and successful exact-head/base GitHub CI and `CI Gate`. Merge
   through `pnpm lastcode:merge`. If the base changes, refresh the branch as
   needed and obtain fresh validation against the new base before merging.

The LastCode PR does not wait for upstream acceptance. The upstream PR does not
depend on LastCode. When upstream later lands the change, let the nightly rebase
reconcile the duplicate patch and record any recurring resolution through the
existing checkpoint workflow.

## Handoff

Report both branch names and any PR URLs, their bases and current heads, validation
performed for each, review status, and whether either delivery remains local.
Open LastCode PRs do not pause checkpoint creation, repaired-checkpoint
publication, or branch promotion. Report any validation that needs refreshing
after the LastCode base changes.
