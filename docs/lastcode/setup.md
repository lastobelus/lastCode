# Set Up LastCode Alongside T3 Code

LastCode is currently a personal source-build workflow for Apple Silicon macOS,
not a public binary distribution. It can run alongside an installed T3 Code or
T3 Code Nightly app because its bundle identity, Electron profile, state home,
single-instance lock, and URL schemes are separate.

| Resource    | LastCode                     | T3 Code                      |
| ----------- | ---------------------------- | ---------------------------- |
| Application | `/Applications/LastCode.app` | `/Applications/T3 Code*.app` |
| Bundle ID   | `codes.lastobelus.lastcode`  | `com.t3tools.t3code`         |
| State home  | `~/.lastcode`                | `~/.t3`                      |
| URL schemes | `lastcode`, `lastcode-dev`   | `t3code`, `t3code-dev`       |

Provider credentials remain in provider-owned directories such as `~/.codex`,
so both apps can use the same authenticated provider without sharing their T3
application state.

## Prerequisites

- Apple Silicon macOS;
- Git and a personal, writable GitHub fork of `lastobelus/LastCode`;
- an authenticated [GitHub CLI](https://cli.github.com/);
- [mise](https://mise.jdx.dev/), [Vite+](https://viteplus.dev/guide/), and
  [fzf](https://github.com/junegunn/fzf); and
- at least one authenticated provider supported by T3 Code.

The writable fork is essential. The checkpoint daemon does more than fetch: at
login and hourly it rebases LastCode onto new T3 Code nightlies, pushes immutable
`lastcode/checkpoint/*` and `lastcode/revision/*` tags, promotes
`lastcode/main` when no LastCode pull request is open, and mirrors upstream
`main`. Do not point `origin` at a repository you do not intend this machine to
update.

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
mise exec node@24.13.1 -- node scripts/lastcode-setup.mjs --enable-nightly-writes
```

The explicit flag acknowledges the remote writes described above. The command:

1. installs the pinned workspace dependencies;
2. creates a detached `lastcode-automation` worktree beside the checkout;
3. installs a macOS LaunchAgent that runs at login and hourly;
4. starts the first checkpoint run; and
5. installs `lastcode-checkpoints`, `lastcode-build`, and `lastcode-install`
   under `~/.local/bin` with their managed files under `~/.lastcode/bin`.

If service setup or a later helper installation fails, the bootstrap disables a
checkpoint service that it newly installed during that run. A service that was
already installed before a rerun is not removed by this rollback.

Add `~/.local/bin` to `PATH` if it is not already present. To inspect the exact
actions without changing anything, add `--dry-run`.

## Build and install the first app

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

The build runs full local CI and creates an ad-hoc-signed, non-notarized DMG
under `~/.lastcode/local-updates/artifacts`. The installer validates that DMG,
installs `/Applications/LastCode.app`, and launches it. It does not replace or
modify the T3 Code application.

On first launch, open **Settings → LastCode** to selectively import appearance,
keyboard, and server-behavior settings from T3 Code. The import copies supported
settings once; the two profiles remain independent. Enable **Show and install
local nightlies** there if you want future ready checkpoints to appear in
LastCode's update UI.

Tailscale Serve is machine-global, so do not configure T3 Code and LastCode to
claim the same Serve port simultaneously.

## Operate or remove the automation

```bash
pnpm lastcode:checkpoint:service status
pnpm lastcode:checkpoint:service run-now
pnpm lastcode:checkpoint:service uninstall
```

Uninstalling the service retains a timestamped disabled plist and does not
remove the checkout, worktrees, tags, build artifacts, or installed app.
