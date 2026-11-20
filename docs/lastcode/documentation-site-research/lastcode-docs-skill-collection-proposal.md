> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

# Proposed documentation skill collection

## Keep the collection inside `lastcode-docs`

Commit every documentation skill and agent rule only to the separate `lastcode-docs` repository. Do not install these skills globally, copy them into LastCode, or add them to LastCode product branches.

The managed LastCode process may start work in the docs checkout and run its package commands. It must not load the docs skill collection while it performs product work.

## Require the writing skills for every docs agent

The docs repository root `AGENTS.md` must tell every agent to read and apply these two files before any task:

- `.agents/skills/unslop/SKILL.md`
- `.agents/skills/technical-writing/SKILL.md`

This rule also applies to code, capture, review, issue, pull-request, and delegation work. Every subagent task must name both skills. The managed docs-thread prompt must repeat the rule so providers that do not discover project skills still receive it.

Keep `AGENTS.md` authoritative. Add a one-line `CLAUDE.md` import and the smallest always-applied Cursor rule needed to point those providers back to `AGENTS.md`. Do not maintain separate copies of the instructions.

## Provide five skills

Vendor three upstream skills under `.agents/skills`:

1. `unslop`, required for every task.
2. `technical-writing`, required for every task that can change words. Its own instructions also require `unslop`.
3. `playwright-cli`, used only to author or debug browser capture recipes.

Add two small LastCode-owned skills:

1. `document-lastcode` guides feature-page, explanation, reference, install-guide, and README work. It selects the document type, checks the feature registry and recorded LastCode revision, verifies claims against source, applies the page contract, and hands exact validation commands to the agent. The freshness and publishing ticket will define those commands.
2. `capture-lastcode` guides still and video work. It requires public synthetic fixtures, exact Ocean appearances, stable recipes, privacy checks, paired light and dark output where available, and capture-manifest updates. It invokes `playwright-cli` only for interactive authoring or debugging. Scheduled capture runs execute checked-in scripts directly.

Keep detailed contracts in focused `references/` files so unrelated instructions do not enter the agent's context.

Do not vendor Wayfinder. It plans this effort but is not part of routine documentation maintenance. Do not vendor a Cap skill. Cap remains a human-approved native recording tool, not an unattended agent path. Do not vendor the GitHub screen-recording skill or the LastCode `test-t3-app` skill. The LastCode process owns fixtures and app startup behind stable commands.

## Pin and attribute upstream files

Pin pstack to commit `68836ddaf5697224520f1847d90cdb90ca8babaa` from `cursor/plugins`. Copy only:

- `pstack/skills/unslop/SKILL.md`
- `pstack/skills/technical-writing/SKILL.md`
- `pstack/LICENSE`

The pstack license is MIT and names Lauren Tan. Preserve the full notice.

Pin Playwright to commit `1b44f5a441f391538c42c7ce36dd8ce779a5d6a1` from `microsoft/playwright`. Copy its `playwright-cli/SKILL.md`, all nine Markdown files in its `references/` directory, the repository `LICENSE`, and `NOTICE`. The pinned skill subtree is byte-identical to current Playwright `main` as checked on August 29, 2026.

Use `.agents/skills/upstream.lock.json` to record each repository URL, exact revision, source directory, destination directory, SPDX license, copied notice paths, and the SHA-256 digest of every vendored file. Store copied licenses under `.agents/skills/vendor-licenses/`, outside skill discovery.

The [Agent Skills specification](https://agentskills.io/specification) defines `SKILL.md`, `scripts/`, `references/`, and `assets/`. Validate every first-party and vendored skill against that format.

## Make updates explicit and reviewable

Add one repository command that accepts a named source and an explicit revision. The command checks out that revision in a temporary directory, copies only the allowed skill directory and license files, and regenerates `upstream.lock.json`.

Add an offline CI command that checks all recorded digests, rejects unlisted files in vendored skill directories, validates skill metadata, and confirms that the required license files exist.

Never follow an upstream default branch during a normal docs run. Do not update skills as part of the LastCode documentation refresh. A maintainer starts a skill update explicitly and reviews its diff like a dependency update.

Pin the Playwright executable and Chromium build separately in `package.json` and the package lock. Override the vendored skill's global-install fallback: agents run the repository-pinned CLI through the package manager.

## Result

Product agents never discover these skills because the files exist only in `lastcode-docs`. Docs agents always load the two writing skills. They load the feature or capture workflow only when the task needs it. Vendored text cannot drift without a visible lockfile and license change.
