# LastCode Personal Release Workflow

LastCode is a personal downstream of `pingdotgg/t3code` used from the
`lastcode/main` branch. `main` remains an upstream mirror for clean pull request
work against `pingdotgg/t3code`.

GitHub Actions are intentionally disabled. Validation and Apple Silicon builds
run locally under the repository's Node 24.13.1 engine through `mise`, and
releases are created ad hoc rather than on a schedule.

## Local CI

Every push runs the quick gate through `.vite-hooks/pre-push`:

```bash
pnpm lastcode:ci:quick
```

The quick gate ensures the Electron runtime exists, then runs repository format
and lint checks, workspace typechecking, and workspace tests. Tests receive an
isolated Git configuration so personal hooks and default-branch preferences do
not make their temporary repositories behave differently from clean CI runners.

Before merging or building a release, run the full gate from a clean worktree:

```bash
pnpm lastcode:ci
```

The full gate fetches `origin/lastcode/main`, verifies that the branch contains
that exact base commit, and runs everything in the quick gate plus:

- Rust formatting and resource-monitor tests
- the desktop build and upstream's preload-bundle assertions
- mobile native static analysis
- release smoke tests

Success writes a local stamp for both the tested head commit and base commit in
the repository's shared Git directory. If the base branch advances, the stamp
is invalid and CI must be rerun after rebasing.

Merge the current branch's ready PR with:

```bash
pnpm lastcode:merge
```

The wrapper refuses dirty worktrees, unstamped commits, stale bases, draft PRs,
conflicting PRs, and PRs that do not target `lastcode/main`. It then uses a
squash merge guarded by GitHub's exact-head match.

## Nightly Sync

Update `lastcode/main` to the latest upstream nightly tag:

```bash
pnpm lastcode:sync-nightly
```

Push the rebased branch when the result is ready to share:

```bash
pnpm lastcode:sync-nightly --push
```

The script:

- fetches tags from `upstream`
- resolves the newest `vX.Y.Z-nightly.YYYYMMDD.N` tag
- switches to `lastcode/main`
- rebases LastCode-only commits on that tag
- optionally pushes with `--force-with-lease`

Use this before starting new LastCode development and whenever upstream
publishes a nightly that should become the private fork base.

## Apple Silicon Build

Build the local macOS Apple Silicon artifact:

```bash
pnpm lastcode:build:mac:arm64
```

Local macOS packages are sealed with Electron Builder's ad-hoc identity, so the
app bundle and its resources pass macOS code-signature verification without an
Apple Developer certificate. They are not notarized for public distribution.

The wrapper resolves the latest upstream nightly tag and runs the desktop
artifact builder with that version. Output goes to `release-lastcode/`.

Run the full local CI gate on the exact commit being packaged first. Artifacts
stay local unless a GitHub release is explicitly created; releases in the
public fork are public.

Packaging identity:

- Product name: `†Code`
- ASCII artifact/app identifiers: `LastCode`
- Bundle id: `codes.lastobelus.lastcode`
- URL schemes: `lastcode` and `lastcode-dev`

## Running Alongside T3 Code

LastCode uses a separate desktop identity and can run at the same time as an
installed T3 Code or T3 Code Nightly build. The isolated runtime resources are:

- Electron profiles: `lastcode` and `lastcode-dev`, instead of `t3code` and
  `t3code-dev`
- Application state: `~/.lastcode`, instead of `~/.t3`
- URL schemes: `lastcode` and `lastcode-dev`, instead of `t3code` and
  `t3code-dev`
- Bundle/application identifiers and Linux desktop identities under the
  `codes.lastobelus.lastcode` and `lastcode` namespaces

The separate Electron profile also scopes LastCode's single-instance lock, so
launching it cannot focus or terminate T3 Code. Backend ports are selected from
the existing available-port range, allowing both local servers to start.

Provider credentials remain in their provider-owned locations, such as
`~/.codex`, so signing into a coding provider does not need to be duplicated.
LastCode settings, sessions, logs, attachments, browser artifacts, and local
server data remain isolated.

Tailscale Serve is machine-global. Do not enable the same Serve port in both
applications at once; keep it disabled in the fallback app or configure
different ports.

## Fork Workflow Bootstrap Branch

`topic/fork-workflow-bootstrap` is not merged into `lastcode/main`.

It encodes an older vendor/product workflow with Aadit fork tracking. That does
not match the current strategy, which intentionally does not pull from Aadit.
LastCode commands resolve the current worktree with `git rev-parse
--show-toplevel`; only cross-worktree metadata such as local CI stamps belongs
under Git's common directory.

## In-App Update Direction

The existing update button is backed by `electron-updater`: it checks a release
feed, downloads a published artifact, then restarts into the downloaded update.

The requested LastCode updater is a different operation. It needs a local
orchestrator that:

1. fetches the latest nightly tag from `pingdotgg/t3code`
2. rebases released LastCode work onto that tag
3. invokes Codex if the rebase or follow-up work needs agent assistance
4. builds a new Apple Silicon artifact locally
5. exposes the same update states the UI already understands: downloading,
   downloaded, and install/restart

That should be implemented as a separate LastCode update backend instead of
overloading `electron-updater` internals.
