> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

# LastCode README feature prototype

This block replaces the current `LastCode:` feature bullets near the top of the README. The risk paragraphs immediately following it remain static, with the outdated feature enumeration removed as shown below.

<!-- lastcode-features:start -->

## What LastCode adds

LastCode keeps T3 Code's core experience and adds focused tools for coordinating long-running agent work.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://lastobelus.github.io/lastcode-docs/media/readme/workspace-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://lastobelus.github.io/lastcode-docs/media/readme/workspace-light.png">
  <img src="https://lastobelus.github.io/lastcode-docs/media/readme/workspace-dark.png" alt="LastCode in the Ocean theme with a scaled legacy sidebar, a thread annotation, and a resumable action running in the active chat.">
</picture>

- [**Resumable project actions**](https://lastobelus.github.io/lastcode-docs/features/resumable-actions/) — Agents can start a Project Action and then pause while it runs. LastCode wakes the thread when the Action finishes; in the meantime, you can inspect or cancel it. We added this because we were tired of paying the polling tax: wasting turns and tokens checking whether a command was done.
- [**Codex thread tools**](https://lastobelus.github.io/lastcode-docs/features/codex-thread-tools/) — Let Codex list and inspect LastCode threads, read bounded recent context, and send tracked follow-up work.
- [**Thread annotations**](https://lastobelus.github.io/lastcode-docs/features/thread-annotations/) — Attach a short note to a thread so its current purpose stays visible in chat and the sidebar; resolve or reopen it as the work changes.
- [**Legacy sidebar conveniences**](https://lastobelus.github.io/lastcode-docs/features/legacy-sidebar/) — Use the compact project-and-thread layout with adjustable scale, status indicators, and worktree context.
- [**Local nightly updates**](https://lastobelus.github.io/lastcode-docs/features/local-nightly-updates/) — On Apple Silicon macOS, follow T3 Code nightlies, inspect changes, and build or install isolated LastCode revisions locally.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://lastobelus.github.io/lastcode-docs/media/readme/local-nightly-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://lastobelus.github.io/lastcode-docs/media/readme/local-nightly-light.png">
  <img src="https://lastobelus.github.io/lastcode-docs/media/readme/local-nightly-dark.png" alt="LastCode's desktop update panel showing release notes and progress for a local nightly build.">
</picture>
<!-- lastcode-features:end -->

LastCode's experimental features increase both the security-sensitive surface area and the risk that agents could delete or damage data on your machine. They have not been exhaustively reviewed for those risks.

Use LastCode with that additional risk in mind. For the smaller upstream surface and its supported release path, use [T3 Code](https://github.com/pingdotgg/t3code).

## Generation notes

- The feature registry supplies the heading order, titles, one-sentence summaries, page paths, and panel capture IDs.
- The generator replaces only the delimited block.
- A recipe should omit its light `<source>` until the light asset exists; the dark `<img>` remains the fallback.
- Both panels use the same stable assets as the Pages site. They are not README-only captures.
- GitHub selects the matching `<picture>` source without adding a carousel or another panel.
