# Set Up LastCode Alongside T3 Code

LastCode is currently a source-build workflow, not a public binary
distribution. Its guarded setup command provisions an Apple Silicon
checkpoint/release coordinator with local build and install helpers. Other
roles—GUI/controller, server, Intel DMG builder, artifact consumer, and version
source—may run on separate nodes. LastCode can run alongside an installed T3
Code or T3 Code Nightly app because its bundle identity, Electron profile,
state home, single-instance lock, and URL schemes are separate.

| Resource    | LastCode                     | T3 Code                      |
| ----------- | ---------------------------- | ---------------------------- |
| Application | `/Applications/LastCode.app` | `/Applications/T3 Code*.app` |
| Bundle ID   | `codes.lastobelus.lastcode`  | `com.t3tools.t3code`         |
| State home  | `~/.lastcode`                | `~/.t3`                      |
| URL schemes | `lastcode`, `lastcode-dev`   | `t3code`, `t3code-dev`       |

Provider credentials remain in provider-owned directories such as `~/.codex`,
so both apps can use the same authenticated provider without sharing their T3
application state.

## Coordinator and Apple Silicon builder prerequisites

- Apple Silicon macOS;
- Git and a personal, writable GitHub fork of `lastobelus/LastCode`;
- an authenticated [GitHub CLI](https://cli.github.com/);
- [mise](https://mise.jdx.dev/), [Vite+](https://viteplus.dev/guide/), and
  [fzf](https://github.com/junegunn/fzf); and
- at least one authenticated provider supported by T3 Code.

These prerequisites apply to the node that runs `lastcode:setup`; they are not
requirements for every LastCode GUI or server node.

The writable fork is essential. The managed checkpoint service does more than
fetch: it rebases LastCode onto new T3 Code nightlies, pushes immutable
`lastcode/checkpoint/*` and `lastcode/revision/*` tags, promotes
`lastcode/main` when no LastCode pull request is open, and mirrors upstream
`main`. Do not point `origin` at a repository you do not intend the
checkpoint/release coordinator to update.

## Clone and bootstrap

Fork `lastobelus/LastCode` on GitHub, then clone your fork. Its default branch
must be `lastcode/main`.

```bash
git clone git@github.com:YOUR_GITHUB_USER/LastCode.git ~/projects/lastCode
cd ~/projects/lastCode
git switch lastcode/main
git remote add upstream https://github.com/pingdotgg/t3code.git
```

Run the guarded bootstrap from the checkout:

```bash
mise exec node@24.13.1 -- node scripts/lastcode-setup.mjs \
  --enable-nightly-writes \
  --checkpoint-interval-seconds "$LASTCODE_CHECKPOINT_INTERVAL_SECONDS"
```

Deployment configuration must set `LASTCODE_CHECKPOINT_INTERVAL_SECONDS` to a
positive integer. The explicit flag acknowledges the remote writes described
above. The command:

1. installs the pinned workspace dependencies;
2. registers the LastCode project and reconciles its non-setup `t3.json`
   Actions into the local LastCode environment;
3. creates a detached `lastcode-automation` worktree beside the checkout;
4. installs the managed macOS checkpoint service;
5. starts the first checkpoint run; and
6. installs `lastcode-checkpoints`, `lastcode-build`, and `lastcode-install`
   under `~/.local/bin` with their managed files under `~/.lastcode/bin`.

Reconciled Actions are available immediately but are not granted agent resume
permission by default. Existing imported Actions keep their IDs, keybindings,
and local permission. To make a repository-owned Action resumable as an
explicit setup choice, repeat `--trusted-project-action` with its stable source
ID: `lc-wait-for-pr`, `lc-local-ci`, or `lc-build-intel-package`. Setup saves
the selected allowlist for reconciliation after later managed checkout
refreshes; rerunning setup without an ID removes only the corresponding managed
grant.

If service setup or a later helper installation fails, the bootstrap disables a
checkpoint service that it newly installed during that run. A service that was
already installed before a rerun is not removed by this rollback.

Add `~/.local/bin` to `PATH` if it is not already present. To inspect the exact
actions without changing anything, add `--dry-run`.

## Build and install the first Apple Silicon app

The daemon does not build an application. Once this command shows a ready
checkpoint or revision:

```bash
lastcode-checkpoints --verbose
```

build and install it explicitly:

```bash
lastcode-build
lastcode-install
```

On this combined coordinator and Apple Silicon DMG builder, the build runs
full local CI and creates an ad-hoc-signed, non-notarized DMG
under `~/.lastcode/local-updates/artifacts`. The installer validates that DMG,
installs `/Applications/LastCode.app`, and launches it. It does not replace or
modify the T3 Code application.

On first launch, open **Settings → LastCode** to selectively import appearance,
keyboard, and server-behavior settings from T3 Code. The import copies supported
settings once; the two profiles remain independent. Enable **Show and install
local nightlies** there if you want future ready checkpoints to appear in
LastCode's update UI.

Tailscale Serve is node-global, so a node performing both T3 Code and LastCode
server roles must not configure them to claim the same Serve port
simultaneously.

## Operate or remove the automation

```bash
pnpm lastcode:checkpoint:service status
pnpm lastcode:checkpoint:service run-now
pnpm lastcode:checkpoint:service uninstall
```

Uninstalling the service retains a timestamped disabled plist and does not
remove the checkout, worktrees, tags, build artifacts, or installed app.
