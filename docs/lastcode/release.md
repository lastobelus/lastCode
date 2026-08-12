# LastCode Local Release Workflow

LastCode uses local validation and ad-hoc macOS releases. GitHub Actions are
intentionally disabled, releases have no schedule, and artifacts remain local
unless an explicit publishing operation is performed.

Nightly source tracking is documented separately in
[Nightly Checkpoint Workflow](nightly-workflow.md).

## Pull Request CI

Every push runs the quick gate through `.vite-hooks/pre-push`:

```bash
pnpm lastcode:ci:quick
```

Before merging a LastCode PR, run the full gate from a clean feature branch:

```bash
pnpm lastcode:ci
```

The full PR gate fetches `origin/lastcode/main`, verifies that the tested head
contains that exact base commit, and runs formatting, linting, workspace
typechecks and tests, desktop build assertions, Rust tests, native static
analysis, and release smoke tests. Success writes a local stamp bound to both the
head commit and tested base.

Merge the current ready PR with:

```bash
pnpm lastcode:merge
```

The merge wrapper refuses dirty worktrees, unstamped commits, stale bases, draft
or conflicting PRs, and PRs that do not target `lastcode/main`. It squash-merges
with an exact-head guard.

## Checkpoint CI

A release build uses a different full-CI context because rebasing intentionally
rewrites ancestry. Check out the immutable checkpoint and run:

```bash
pnpm lastcode:ci --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The resulting stamp binds the exact LastCode commit, checkpoint tag, upstream
tag, and upstream commit. A PR stamp cannot authorize a checkpoint build, and a
checkpoint stamp cannot authorize a PR merge.

## Apple Silicon Build

Build the selected checkpoint:

```bash
pnpm lastcode:build:mac:arm64 \
  --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The wrapper requires:

- a clean worktree;
- `HEAD` equal to the annotated checkpoint target;
- a valid full checkpoint-CI stamp; and
- a new, non-overwriting output directory.

The app bundle is sealed with Electron Builder's ad-hoc identity, so the bundle
and its resources pass macOS code-signature verification without an Apple
Developer certificate. It is not notarized for public distribution.

Local builds omit the hosted update feed. The built-in updater remains disabled
until LastCode intentionally publishes compatible releases.

## Runtime Identity

LastCode can run alongside T3 Code and T3 Code Nightly because it owns separate
runtime resources:

| Resource         | LastCode                    | T3 Code                 |
| ---------------- | --------------------------- | ----------------------- |
| Product          | `LastCode`                  | `T3 Code`               |
| Bundle ID        | `codes.lastobelus.lastcode` | `com.t3tools.t3code`    |
| Electron profile | `lastcode` / `lastcode-dev` | `t3code` / `t3code-dev` |
| State home       | `~/.lastcode`               | `~/.t3`                 |
| URL schemes      | `lastcode`, `lastcode-dev`  | `t3code`, `t3code-dev`  |

The profile split also separates Chromium storage and the Electron
single-instance lock. Provider credentials remain in provider-owned locations,
such as `~/.codex`, so they do not need to be duplicated.

Tailscale Serve is machine-global. Do not configure both applications to claim
the same Serve port simultaneously.

## In-App Update Direction

The hosted `electron-updater` path downloads published releases. A future local
LastCode updater would instead need to invoke the checkpoint, local CI, and build
workflow and then install the resulting artifact. It should be a separate local
orchestrator rather than an overload of the hosted updater.
