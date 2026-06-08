# LastCode Private Release Workflow

LastCode is the private fork of `pingdotgg/t3code` used from the
`lastcode/main` branch. `main` remains an upstream mirror for clean pull request
work against `pingdotgg/t3code`.

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

The wrapper resolves the latest upstream nightly tag and runs the desktop
artifact builder with that version. Output goes to `release-lastcode/`.

Packaging identity:

- Product name: `†Code`
- ASCII artifact/app identifiers: `LastCode`
- Bundle id: `codes.lastobelus.lastcode`
- URL scheme: `lastcode`

## Fork Workflow Bootstrap Branch

`topic/fork-workflow-bootstrap` is not merged into `lastcode/main`.

It added a useful idea, resolving the repository root from Git's common dir so
scripts work from linked worktrees, and the LastCode nightly scripts use that
pattern. The branch also encodes an older vendor/product workflow with Aadit
fork tracking. That does not match the current strategy, which intentionally
does not pull from Aadit.

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
