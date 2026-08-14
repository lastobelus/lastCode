---
name: upstream-fix
description: Prepare and deliver a general T3 Code fix or improvement that should be proposed to pingdotgg/t3code while LastCode retains an independent copy. Use for upstream-worthy bugs and features, paired upstream and LastCode PRs, refreshing the clean contribution base, or porting an upstream candidate into lastcode/main. Do not use for Markover integration, LastCode branding, personal workflow assumptions, or release automation; use lastcode-pr for those.
---

# Upstream Fix

Deliver one logical improvement through two independent branches: an
upstream-pure contribution and a LastCode port. Keep their bases, reviews, CI,
and merge decisions separate.

## Classify the Change

Use this workflow only when the behavior makes sense to a T3 Code user with no
LastCode or Markover context. Route fork identity, Markover integration, personal
conveniences, nightly automation, and local release machinery to `lastcode-pr`.

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

Do not open a PR unless the user explicitly asks.

## Prepare the LastCode Delivery

1. Fetch `origin` again and create `port/upstream/<topic>` from the exact
   `origin/lastcode/main`.
2. Cherry-pick the upstream change when clean; otherwise reimplement the same
   behavior against LastCode without dragging in unrelated upstream history.
3. Preserve any LastCode-specific adaptation only on this branch.
4. Run focused validation. A push invokes quick local CI.
5. When asked to open a PR, target `lastobelus/lastCode:lastcode/main` and link
   the upstream PR in both descriptions.
6. Before merge, require a current-head clean Codex review, zero unresolved
   review threads, and full local CI for the exact head and current base. Merge
   through `pnpm lastcode:merge`.

The LastCode PR does not wait for upstream acceptance. The upstream PR does not
depend on LastCode. When upstream later lands the change, let the nightly rebase
reconcile the duplicate patch and record any recurring resolution through the
existing checkpoint workflow.

## Handoff

Report both branch names and PR URLs, their bases and current heads, validation
performed for each, review status, and whether either delivery remains local.
Call out that an open LastCode PR pauses branch promotion while immutable nightly
checkpoint tags continue.
