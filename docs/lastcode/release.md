# LastCode Local Release Workflow

LastCode uses local validation and ad-hoc macOS releases. Ordinary branch CI
remains local. The one GitHub-hosted packaging path is manually dispatched for
an exact Intel checkpoint or revision; releases have no schedule.

Nightly source tracking is documented separately in
[Nightly Checkpoint Workflow](nightly-workflow.md).

## Pull Request CI

Ordinary branch pushes run the quick gate through `.vite-hooks/pre-push`:

```bash
pnpm lastcode:ci:quick
```

The checkpoint runner is the narrow exception: after a checkpoint or revision
candidate passes its dedicated smoke gate, its immutable tag and subsequent
`lastcode/main` promotion push with `--no-verify`. This avoids rerunning the
workspace suite from the automation checkout and prevents GitHub from closing an
idle SSH connection while the hook runs. Exact upstream `main` mirroring also
uses `--no-verify` because it pushes the unchanged upstream commit. Without a
smoke result or published tag, promotion retains the quick pre-push gate and
refuses to proceed unless the invoking checkout is the exact candidate commit
that hook will validate.

### Repository integrity guards

Local CI has three independent Git-safety boundaries:

1. The pre-push hook clears every repository-local environment variable listed
   by `git rev-parse --local-env-vars` before invoking the package runner. This
   prevents Git's hook-only `GIT_DIR`, `GIT_WORK_TREE`, index, object, shallow,
   and replacement-ref paths from leaking into nested commands.
2. Every child process started by the LastCode CI runner receives the same
   repository-local environment cleanup. Repository tests also receive a
   disposable global Git config, so fixture identities and defaults cannot be
   written into the shared repository config.
3. Before quick or full CI starts, the runner requires `core.bare=false` in the
   shared Git config and snapshots its repository-wide settings. It checks the
   value, protected settings, and common Git directory again on every exit,
   including failed CI runs. Any protected change fails the gate with the config
   path to inspect. Existing per-branch settings are preserved too, while new
   branch keys are allowed because T3 and GitHub CLI legitimately add
   branch/worktree bookkeeping while CI runs in another worktree.

These guards protect the primary checkout and every linked worktree, which all
share the same Git config. They specifically prevent temporary-repository tests
from reinitializing or reconfiguring the real repository when CI is launched by
a Git hook. They do not automatically repair an integrity failure: stop, inspect
the reported config and worktree state, and preserve evidence before changing
anything.

Workspace test tasks run one package, one Vitest worker, and one concurrent test
case at a time. This takes longer than the task-runner defaults but avoids
cross-suite state leaks plus memory and CPU contention between the web, mobile,
desktop, and server suites on the single local build machine.

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
with an exact-head guard, then requests an immediate checkpoint-daemon run. The
daemon publishes a new installable LastCode revision when no new upstream
nightly is waiting. Failure to start the service is reported without lying about
the already-completed GitHub merge; the hourly service run remains the repair
path. The request never terminates a daemon run already in progress.

## Checkpoint CI

A release build uses a different full-CI context because rebasing intentionally
rewrites ancestry. Check out the immutable checkpoint or revision and run:

```bash
pnpm run lastcode:ci -- --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The resulting stamp binds the exact LastCode commit, installable tag, upstream
tag, and upstream commit. A PR stamp cannot authorize a checkpoint build, and a
checkpoint stamp cannot authorize a PR merge.

## Apple Silicon Build

Build the selected checkpoint or revision:

```bash
pnpm lastcode:build:mac:arm64 \
  --checkpoint lastcode/checkpoint/<upstream-nightly-tag>
```

The wrapper requires:

- a clean worktree;
- `HEAD` equal to the annotated checkpoint or revision target;
- a valid full checkpoint-CI stamp; and
- a new, non-overwriting output directory.

The app bundle is sealed with Electron Builder's ad-hoc identity, so the bundle
and its resources pass macOS code-signature verification without an Apple
Developer certificate. It is not notarized for public distribution.

Local builds omit the hosted update feed. The built-in updater remains disabled
until LastCode intentionally publishes compatible releases.

## Intel Build Publication

The manually dispatched **LastCode Intel artifact** workflow accepts one exact
`lastcode/checkpoint/...` or `lastcode/revision/...` tag and its full advertised
commit. It rejects moving refs and tag/commit mismatches, runs the checkpoint's
full CI gate on `macos-15-intel`, and builds a certificate-free x64 artifact.

Successful output is attached to the installable tag as a GitHub prerelease,
explicitly excluded from GitHub's latest-release selection. The release contains
the complete build-manifest asset set, `build-manifest.json`, and `SHA256SUMS`.
Before publishing, and again after downloading the published assets, automation
requires the manifest's x64/macOS architecture, exact tag and commit, byte
counts, checksums, and asset set to agree.

Repository **Settings → Releases → Immutable releases** must be enabled before
dispatch. The workflow checks that repository policy before checking out target
code, checks it again in the isolated publisher, and fails without building or
publishing when the setting is unavailable or disabled. Enabling the setting is
an explicit maintainer action; the workflow never changes repository policy.

The Intel build job has read-only repository access. It transfers the validated
asset set to a fresh publication job, which revalidates the assets and tag before
receiving write access; target-controlled build steps never share that token.

A rerun for a complete matching release exits successfully before dependency
installation, CI, or packaging. An existing draft, non-prerelease, partial,
foreign, or mismatched asset set fails closed. Automation never clobbers or
deletes an exact-tag release. Recovery from a partial or conflicting publication
therefore requires a maintainer decision rather than silently changing an
immutable artifact.

This workflow remains manual-only. Scheduling, target-host staging, and
installation are separate rollout gates.

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

## In-App Local Updates

The default-off local updater is documented in
[Local Nightly Updates](local-nightly-updates.md). It discovers immutable
checkpoint and LastCode revision tags, builds a selected tag in a separate
dedicated worktree, and stages the generated updater ZIP through Electron's
existing macOS install machinery. Checkpoint scheduling remains independent:
the daemon never builds merely because it found a new nightly or revision.
