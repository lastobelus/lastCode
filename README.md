# LastCode

LastCode is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code). Thank you to T3 Code's creators and maintainers for building it in the open and making this fork possible.

LastCode:

- Tracks T3 Code nightly.
- Takes over the update UI and installs a daemon that checkpoints T3 Code nightly, then rebases LastCode's changes on top.
- Favors the legacy sidebar. We do not QA LastCode changes against the inbox sidebar, although fix pull requests are welcome.
- Adds experimental features that increase both the security-sensitive surface area and the risk that agents could delete or mangle data on your machine. These changes have not been exhaustively reviewed for those risks. They include letting tools wake up threads, planned support for threads talking to each other, URL schemes that make emitted links clickable, and integrations with personal tools used by the maintainer, such as Markover.

Use LastCode with that additional risk in mind. For the smaller upstream surface and its supported release path, use [T3 Code](https://github.com/pingdotgg/t3code).

## Install LastCode alongside T3 Code

LastCode is currently a personal source-build workflow for Apple Silicon macOS, not a public binary distribution. It installs as `/Applications/LastCode.app` and keeps its bundle identity, application state (`~/.lastcode`), Electron profile, single-instance lock, and URL schemes separate from T3 Code. Both apps can therefore remain installed and run on the same Mac.

The setup mirrors the maintainer's arrangement: a personal writable GitHub fork, a dedicated automation worktree, and a macOS daemon that rebases LastCode onto T3 Code nightlies at login and hourly. The daemon pushes checkpoint and revision tags, promotes `lastcode/main` when no LastCode pull request is open, and mirrors upstream `main`, so do not install it against an `origin` you do not intend to update.

After installing Git, [GitHub CLI](https://cli.github.com/), [mise](https://mise.jdx.dev/), [Vite+](https://viteplus.dev/guide/), and [fzf](https://github.com/junegunn/fzf), fork this repository and run:

```bash
git clone git@github.com:YOUR_GITHUB_USER/LastCode.git ~/projects/lastCode
cd ~/projects/lastCode
git switch lastcode/main
git remote add upstream https://github.com/pingdotgg/t3code.git
mise exec node@24.13.1 -- node scripts/lastcode-setup.mjs --enable-nightly-writes
```

When `lastcode-checkpoints --verbose` shows a ready installable, build and install the first app:

```bash
lastcode-build
lastcode-install
```

The full setup guide explains the remote-write boundary, initial ad-hoc-signed build, settings import, runtime isolation, updater opt-in, and uninstall commands: [Set up LastCode alongside T3 Code](./docs/lastcode/setup.md).

## About T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Install T3 Code

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
