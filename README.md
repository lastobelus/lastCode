# LastCode

LastCode is a personal fork of [T3 Code](https://github.com/pingdotgg/t3code). Thank you to T3 Code's creators and maintainers for building it in the open and making this fork possible.

LastCode:

- Tracks T3 Code nightly.
- Takes over the update UI and installs a daemon that checkpoints T3 Code nightly, then rebases LastCode's changes on top.
- Uses the upstream inbox sidebar by default and offers an optional LastCode sidebar under Settings → LastCode → Appearance. The upstream legacy choice remains independent. Automated checks cover sidebar selection and selected LastCode workflows; exhaustive cross-sidebar and desktop/manual acceptance remain incomplete.
- Adds experimental features that increase both the security-sensitive surface area and the risk that agents could delete or mangle data on your machine. These changes have not been exhaustively reviewed for those risks. They include letting tools wake up threads, planned support for threads talking to each other, URL schemes that make emitted links clickable, and integrations with personal tools used by the maintainer, such as Markover.

Use LastCode with that additional risk in mind. For the smaller upstream surface and its supported release path, use [T3 Code](https://github.com/pingdotgg/t3code).

## Install LastCode alongside T3 Code

LastCode is currently a personal source-build workflow for Apple Silicon macOS, not a public binary distribution. It installs as `/Applications/LastCode.app` and keeps its bundle identity, application state (`~/.lastcode`), Electron profile, single-instance lock, and URL schemes separate from T3 Code. Both apps can therefore remain installed and run on the same Mac.

The setup provisions a checkpoint/release coordinator for a writable GitHub
fork, including a dedicated automation worktree and a managed macOS service.
Deployment configuration supplies the service cadence. The coordinator pushes
checkpoint and revision tags, promotes `lastcode/main` when no LastCode pull
request is open, and mirrors upstream `main`, so do not install it against an
`origin` you do not intend to update.

After installing Git, [GitHub CLI](https://cli.github.com/), [mise](https://mise.jdx.dev/), [Vite+](https://viteplus.dev/guide/), and [fzf](https://github.com/junegunn/fzf), fork this repository and run:

```bash
git clone git@github.com:YOUR_GITHUB_USER/LastCode.git ~/projects/lastCode
cd ~/projects/lastCode
git switch lastcode/main
git remote add upstream https://github.com/pingdotgg/t3code.git
mise exec node@26.12.1 -- node scripts/lastcode-setup.mjs \
  --enable-nightly-writes \
  --checkpoint-interval-seconds "$LASTCODE_CHECKPOINT_INTERVAL_SECONDS"
```

Deployment configuration must set `LASTCODE_CHECKPOINT_INTERVAL_SECONDS` to a
positive integer before running the setup command.

When `lastcode-checkpoints --verbose` shows a ready installable, build and install the first app:

```bash
lastcode-build
lastcode-install
```

The full setup guide explains the remote-write boundary, initial ad-hoc-signed build, settings import, runtime isolation, updater opt-in, and uninstall commands: [Set up LastCode alongside T3 Code](./docs/lastcode/setup.md).

## About T3 Code

<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## Install T3 Code

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
