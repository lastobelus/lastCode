# LastCode Contribution and Fork Conventions

This document defines how LastCode separates fork-only work from changes offered
upstream, keeps both contribution bases current, and evaluates other forks.

## Goals

- Keep LastCode usable as the main working fork.
- Keep upstream pull request branches free of LastCode-only commits.
- Make it cheap to compare `pingdotgg/t3code`, `aaditagrawal/t3code`, and other forks.
- Avoid losing provenance for experiments, cherry-picks, or PR evaluations.
- Avoid tag collisions and remote naming drift.

## Two Workstreams

Every change belongs to one of two workstreams before implementation begins.

### LastCode-only work

This stream includes Markover integration, LastCode identity and branding,
personal conveniences, local release and nightly automation, and any feature
that depends on private workflow assumptions. These changes:

- branch from `origin/lastcode/main`;
- use `lastcode/markover/<topic>` for Markover integration or
  `lastcode/<topic>` for other fork-only work;
- target `lastobelus/lastCode:lastcode/main`; and
- are not proposed to T3 Code upstream.

### Upstream candidates retained by LastCode

This stream includes general T3 Code fixes and improvements that should be
offered to `pingdotgg/t3code` but that LastCode wants regardless of the upstream
decision or schedule. Treat it as two independent deliveries of one logical
change:

1. an upstream-pure PR branched from `upstream/main`; and
2. a LastCode port branched from `origin/lastcode/main`.

The upstream branch contains no LastCode branding, Markover integration, local
release automation, or `docs/lastcode` material. Link the two PRs for provenance,
but do not make either merge depend on the other. If upstream later merges the
change, the nightly rebase reconciles the duplicate patch in the normal conflict
resolution process.

When classification is uncertain, ask whether the change would make sense for a
T3 Code user with no LastCode or Markover context. If yes, use the paired
upstream-candidate workflow. Otherwise, keep it LastCode-only.

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
  - Create upstream PR branches from the exact fetched `upstream/main`; `main`
    mirrors that base for GitHub comparisons.
  - Do not add LastCode-only commits directly to `main`.
- `lastcode/main`: canonical LastCode branch.
  - This is the default branch for `lastobelus/lastCode`.
  - Use this branch for LastCode-specific documentation, experiments that become part
    of the fork, and ongoing project state that should not appear in upstream PRs.
  - Branch fork-only work from `lastcode/main`, or use a `lastcode/<topic>` branch
    when the work is not ready for the canonical branch.

This split keeps the GitHub fork useful as a project while keeping upstream
contribution branches clean.

## Contribution Bases

Never use `lastcode/main` as the base for an upstream PR. It contains the entire
downstream patch stack and would contaminate the upstream diff.

Before starting upstream-facing work:

```bash
git fetch upstream --prune
git fetch origin --prune
git push origin upstream/main:main
git switch -c fix/<topic> upstream/main
```

The push keeps the fork's `main` as a fast-forward mirror for GitHub comparisons;
the new branch still names the fetched `upstream/main` commit directly as its
source of truth. If the mirror cannot fast-forward, stop and inspect it rather
than force-pushing or merging downstream history into it.

Immediately before opening or updating the upstream PR, fetch again and rebase
onto the latest `upstream/main`. Push the topic branch to `origin`, then target
`pingdotgg/t3code:main`.

For the LastCode copy, start independently from the current downstream base:

```bash
git fetch origin --prune
git switch -c port/upstream/<topic> origin/lastcode/main
```

Cherry-pick the upstream commit when it applies cleanly; otherwise reimplement
the same behavior against LastCode. Validate and review each PR according to its
target repository. An upstream CI result never substitutes for LastCode local
CI, and a LastCode merge never implies that upstream accepted the change.

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
  - Branches used to bring selected work from another fork into LastCode.
- `sync/<source>/<date>`
  - Structured sync attempts from a known remote into a branch.
- `spike/<topic>`
  - Disposable experiments with no promise of mergeability.
- `fix/<topic>`
  - Upstream-targeted bug fixes branched from `upstream/main`.
- `feat/<topic>`
  - Upstream-targeted features branched from `upstream/main`.
- `port/upstream/<topic>`
  - The independent LastCode copy of an upstream candidate.
- `lastcode/<topic>`
  - Fork-only work branched from `lastcode/main`.
- `lastcode/markover/<topic>`
  - Fork-only Markover integration branched from `lastcode/main`.

Examples:

```bash
eval/upstream/2026-04-17
pr/upstream/1943-port-token-clamp
port/aadit/opencode-adapter-parity
sync/upstream/2026-04-17
spike/provider-registry
fix/subagent-output-interleaving
port/upstream/subagent-output-interleaving
lastcode/fork-conventions
lastcode/markover/review-handoff
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
git fetch origin --prune
git push origin upstream/main:main
git switch -c fix/subagent-output-interleaving upstream/main
```

Rebase onto the latest `upstream/main` before opening the pull request. Push the
branch to `origin`, then target `pingdotgg/t3code:main`.

### Retain an upstream candidate in LastCode

After preparing the upstream-pure change, make the downstream delivery from a
fresh base:

```bash
git fetch origin --prune
git switch -c port/upstream/subagent-output-interleaving origin/lastcode/main
git cherry-pick <upstream-change-commit>
```

Open this PR against `lastcode/main`, link it to the upstream PR, and let the two
reviews and merge decisions proceed independently.

### Start LastCode-only work

```bash
git fetch origin --prune
git switch -c lastcode/markover/review-handoff origin/lastcode/main
```

Target `lastcode/main`. Pushing runs the quick local gate. Before merge, require
a clean current-head Codex review, no unresolved threads, and a full local-CI
stamp for the exact head and current base. Use the guarded LastCode merge command
rather than merging directly in the GitHub UI. After the squash merge succeeds,
the guard requests an immediate checkpoint-daemon run so the merged change can
become an installable `lastcode/revision/...` without waiting for another
upstream nightly.

An open PR targeting `lastcode/main` pauses nightly promotion, but the automation
continues creating immutable checkpoint tags. Promotion catches up after the PR
queue is empty. The daemon also publishes immutable LastCode revisions for
merged downstream work and uses the hourly run to repair a missed merge trigger.

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
- If work is an upstream bug fix or feature, branch from `upstream/main` and use `fix/`
  or `feat/`, then create an independent `port/upstream/` branch when LastCode
  should retain it.
- If work is fork-only, branch from `lastcode/main` and use `lastcode/` or a
  more specific local prefix.

The key distinction is that branches describe intent, while snapshot tags record
states worth remembering.
