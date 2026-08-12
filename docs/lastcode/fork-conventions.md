# LastCode Fork Evaluation Conventions

This document defines how `lastCode` tracks the upstream project, the canonical
LastCode fork branch, notable forks, and candidate pull requests.

## Goals

- Keep `lastCode` usable as the main working fork.
- Keep upstream pull request branches free of LastCode-only commits.
- Make it cheap to compare `pingdotgg/t3code`, `aaditagrawal/t3code`, and other forks.
- Avoid losing provenance for experiments, cherry-picks, or PR evaluations.
- Avoid tag collisions and remote naming drift.

## Repository Layout

- Main fork checkout: `~/projects/lastCode`
- Alternate fork checkouts use owner-qualified names, for example:
  - `~/projects/aadit-t3code`
  - `~/projects/theo-t3code`

Use `lastCode` as the human-facing local project name even though the original
upstream repository name is `t3code`.

## Remote Naming

In `~/projects/lastCode`:

- `origin`: your writable fork, `lastobelus/lastCode`
- `upstream`: the network root or canonical upstream, currently `pingdotgg/t3code`
- `<owner>`: notable alternate forks, for example `aadit`

Examples:

```bash
git remote add aadit git@github.com:aaditagrawal/t3code.git
git remote add theo git@github.com:theodorusclarence/t3code.git
```

Rules:

- `origin` is always the repository this checkout pushes to.
- `upstream` is always the canonical root you want to compare against most often.
- Alternate forks are named by owner, not by repo name.
- Do not rename remotes per feature or topic. Remote names should stay stable.

## Canonical Branches

Use two long-lived mainline branches with distinct jobs:

- `main`: upstream mirror and upstream PR base.
  - Local `main` should be kept aligned with `upstream/main`.
  - Use `main` when creating branches for pull requests targeting `pingdotgg/t3code`.
  - Do not add LastCode-only commits directly to `main`.
- `lastcode/main`: canonical LastCode branch.
  - This is the default branch for `lastobelus/lastCode`.
  - Use this branch for LastCode-specific documentation, experiments that become part
    of the fork, and ongoing project state that should not appear in upstream PRs.
  - Branch fork-only work from `lastcode/main`, or use a `lastcode/<topic>` branch
    when the work is not ready for the canonical branch.

This split keeps the GitHub fork useful as a project while keeping upstream
contribution branches clean.

## Tag Handling

Forks in the same network often reuse release tags such as `v0.0.11`. Fetching
tags from every remote causes collisions and noisy failures.

Rules:

- Only treat tags from `origin` and `upstream` as generally meaningful.
- Configure alternate fork remotes with `--no-tags`.
- Do not use raw upstream tag names to mark local evaluation state.

Example:

```bash
git config remote.aadit.tagOpt --no-tags
git fetch aadit --prune
```

## Branch Policy

Keep `main` clean and upstream-oriented.

Rules:

- `main` tracks `upstream/main`.
- `lastcode/main` is the canonical branch for LastCode-only project state.
- Do not do evaluation work directly on either long-lived branch.
- Create short-lived branches for comparison, import, and spike work.
- Delete branches once their result is merged, rejected, or superseded.

### Branch Prefixes

- `eval/<source>/<topic-or-date>`
  - Read-only or low-risk evaluation branches used to compare behavior or code.
- `pr/<source>/<number>-<slug>`
  - Branches created to inspect or test a specific upstream or fork PR.
- `port/<source>/<topic>`
  - Branches used to bring selected work from another fork into `lastCode`.
- `sync/<source>/<date>`
  - Structured sync attempts from a known remote into a branch.
- `spike/<topic>`
  - Disposable experiments with no promise of mergeability.
- `fix/<topic>`
  - Upstream-targeted bug fixes branched from `main`.
- `lastcode/<topic>`
  - Fork-only work branched from `lastcode/main`.

Examples:

```bash
eval/upstream/2026-04-17
pr/upstream/1943-port-token-clamp
port/aadit/opencode-adapter-parity
sync/upstream/2026-04-17
spike/provider-registry
fix/subagent-output-interleaving
lastcode/fork-conventions
```

## Local Tracking References

Use remote-tracking branches as the source of truth for what came from where.

Examples:

- `upstream/main`
- `aadit/main`
- `aadit/feat/opencode-adapter-parity`

When importing work:

- prefer `cherry-pick` for isolated commits
- prefer `range-diff` before merging branch stacks
- prefer merge branches only when preserving ancestry is useful

## Snapshot Tags

Use annotated tags for stable decision points, not active work.

Recommended format:

- `snapshot/upstream-YYYY-MM-DD`
- `snapshot/<fork>-main-YYYY-MM-DD`
- `snapshot/pr-<number>-tested`
- `snapshot/decision-<short-name>`

Examples:

```bash
git tag -a snapshot/upstream-2026-04-17 -m "Snapshot of upstream/main before fork comparison"
git tag -a snapshot/aadit-main-2026-04-17 -m "Snapshot of aadit/main for evaluation"
```

Rules:

- Snapshot tags should answer "what exact state did I inspect or decide on?"
- Snapshot tags should be annotated.
- Snapshot tags should not be reused or moved.

## Suggested Workflow

### Evaluate upstream against a fork

```bash
git fetch origin --prune
git fetch upstream --prune --tags
git fetch aadit --prune
git log --oneline --decorate --graph upstream/main..aadit/main
git range-diff upstream/main...aadit/main
```

### Start a fork comparison branch

```bash
git switch -c eval/aadit/2026-04-17 lastcode/main
```

### Port a candidate change from another fork

```bash
git switch -c port/aadit/opencode-adapter-parity lastcode/main
git cherry-pick <commit-sha>
```

### Start an upstream pull request branch

```bash
git fetch upstream --prune
git switch main
git pull --ff-only upstream main
git switch -c fix/subagent-output-interleaving
```

Push the branch to `origin`, then open the pull request against
`pingdotgg/t3code:main`.

### Inspect a specific pull request

If a PR branch is available locally through a fork remote, branch from
`lastcode/main` for local evaluation and keep the PR number in the branch name:

```bash
git switch -c pr/upstream/1943-port-token-clamp lastcode/main
```

## Decision Rules

- If work is exploratory, use `eval/`.
- If work is a likely candidate for adoption, use `port/`.
- If work maps to a concrete PR, use `pr/`.
- If work is an explicit sync attempt, use `sync/`.
- If work is messy or disposable, use `spike/`.
- If work is an upstream bug fix or feature, branch from `main` and use `fix/`
  or another upstream-facing topic name.
- If work is fork-only, branch from `lastcode/main` and use `lastcode/` or a
  more specific local prefix.

The key distinction is that branches describe intent, while snapshot tags record
states worth remembering.
