> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

<!-- ticket -->

# Create the lastcode-docs repository and its project-local skills

## Target

Create the public `lastobelus/lastcode-docs` repository. Do not change a LastCode product branch or a global agent directory.

## Acceptance

- Create the repository with `main` as its source branch. Do not add a `gh-pages` branch or commit generated HTML.
- Add a root `AGENTS.md` that requires `unslop` and `technical-writing` for every documentation task and every delegated agent.
- Vendor the approved pinned `unslop`, `technical-writing`, and `playwright-cli` files. Preserve the pstack MIT notice and the Playwright Apache-2.0 license and `NOTICE`.
- Add the first-party `document-lastcode` and `capture-lastcode` skills.
- Add the approved lock file, explicit updater, and offline digest check. Agents must use the repository-pinned Playwright command.
- Add `LICENSE.md`, `LICENSES/MIT.txt`, `LICENSES/CC-BY-4.0.txt`, `THIRD_PARTY_NOTICES.md`, and the path-based contribution terms approved in the planning map.
- Confirm that none of these skills or standing instructions appear in LastCode branches or global Codex configuration.

Keep the bootstrap direct. Do not add a plugin system, submodule, or automatic upstream tracking.

<!-- ticket -->

# Add the LastCode public feature registry and README generator

## Target

Implement this ticket in `lastobelus/lastCode`.

## Acceptance

- Add the versioned `docs/lastcode/features.json` registry with the five approved stable feature IDs.
- Record the approved titles, summaries, page paths, supported clients, literal source prefixes, capture IDs, README order, and panel IDs.
- Use the approved Resumable Project Actions summary verbatim.
- Validate the schema, stable references, and literal source prefixes with focused tests.
- Add an idempotent generator that can update only the delimited README feature block.
- Do not activate the generated README block yet. Its public links must wait for the Pages release.
- Do not add docs-site skills or docs-site source to this repository.

<!-- ticket -->

# Build the VitePress Ocean site shell

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the repository bootstrap and the LastCode feature registry exist.

## Acceptance

- Pin VitePress 1.x and configure `base: "/lastcode-docs/"`, clean URLs, local search, edit links, and last-updated data.
- Add the approved ten-route navigation and page outline.
- Apply the exact Ocean light and dark color roles, the product font stacks, weight-600 article headings, and the approved tinted cards.
- Add an appearance-aware media component for paired light and dark captures.
- Copy the wordmark and current production favicon into `docs/public/brand/`. Record the source commit and MIT notice.
- Check responsive navigation and keyboard access without claiming mobile product QA.
- Leave Icon Composer work in its existing follow-up issue.

Use VitePress defaults when a small theme override is enough.

<!-- ticket -->

# Add synthetic public-doc fixtures and a capture entry point

## Target

Implement this ticket in `lastobelus/lastCode` after the feature registry.

## Acceptance

- Add one environment-neutral command that accepts an explicit LastCode commit and a disposable output directory.
- Create only synthetic identities, paths, projects, threads, and events.
- Never read the live database, secrets, or pairing credentials.
- Use projection seeding for still images and normal product commands for recordings that change state.
- Add the isolated packaged-app state and fake update helper needed for the desktop local-nightly recording. Never run a real nightly build for a capture.
- Exclude mobile from the first release.
- Cover the command and fixture contract with focused tests.

Prefer one deterministic fixture set. Do not build a general fixture framework.

<!-- ticket -->

# Build the deterministic capture runner and media manifest

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the site shell and the LastCode fixture entry point exist.

## Acceptance

- Add a pinned Playwright and Chromium runner with ordinary TypeScript recipe functions.
- Add stable recipe IDs, output IDs, and a versioned media manifest.
- Add one checked-in docs evidence file. Join it directly with the LastCode registry.
- Record page coverage, verification method, checked commit, and capture IDs per supported client.
- Treat captures as demonstrations, not proof of testing. Keep web, desktop, and mobile evidence separate.
- Set Ocean appearance, locale, viewport, reduced motion, font readiness, hidden caret, and cleanup behavior.
- Use semantic locators and explicit readiness signals. Do not use arbitrary sleeps.
- Support light and dark output. Require dark at launch. Require light only for recipes that enable it.
- Validate hashes, dimensions, duration, decoding, posters, alt text, transcripts, stable README paths, and license exceptions.
- Keep Cap outside unattended commands.

Use one JSON evidence file and one pure join. If review repeatedly finds races or edge cases, reduce evidence detail or make a step manual before adding state or coordination.

<!-- ticket -->

# Write the overview, installation, and resumable-actions pages

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the site shell and product registry exist.

## Acceptance

- Write the home page, installation and first-run guide, and Resumable Project Actions feature guide.
- Apply the project-local `unslop` and `technical-writing` skills.
- Use registry-owned titles, summaries, and supported clients instead of duplicating them in prose.
- Use the approved feature-page contract and cross-links.
- Explain Working and Waiting states, inspection, cancellation, and interrupted follow-up recovery.
- Use the approved polling-tax explanation without broader performance claims.
- List mobile as available but not yet verified when the registry includes it. Do not add mobile instructions or media.
- Add capture placeholders that resolve through registered media IDs.

<!-- ticket -->

# Write the thread-tools, annotations, and legacy-sidebar pages

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the site shell and product registry exist.

## Acceptance

- Write the Codex thread-tools feature guide and `lastcode-thread` reference.
- Write the Thread annotations and legacy-sidebar feature guides.
- Apply the project-local `unslop` and `technical-writing` skills.
- State provider, environment, host, timeout, and output-budget limits without implying that every provider has the Codex thread command.
- Keep Thread annotations distinct from preview annotations and diff comments.
- Cover the approved sidebar settings and draft recovery. Treat visual fixes as quality, not separate features.
- Generate supported-client wording from the registry and docs evidence.
- Add capture placeholders that resolve through registered media IDs.

<!-- ticket -->

# Write the local-nightly and feature-availability pages

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the site shell and product registry exist.

## Acceptance

- Write the local-nightly feature guide and bounded explanation of checkpoints and same-nightly revisions.
- Generate the feature-availability reference from the product registry and docs evidence file.
- Apply the project-local `unslop` and `technical-writing` skills.
- Keep operator setup and Intel staging detail in the product repository.
- State the Apple Silicon packaged-desktop boundary and do not imply hosted binary distribution.
- Render the four approved public results: available and verified, available and not yet verified, available and not documented here, and not available.
- Show demonstrations separately from verification.
- Add the native-media placeholder for local-nightly updates.

<!-- ticket -->

# Generate the first automated Ocean capture set

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the capture runner and the first seven content pages exist.

## Acceptance

- Generate the approved Resumable Project Actions still and short WebM.
- Generate the Codex thread-tools output and still.
- Generate the Thread annotations still and the edit, resolve, and reopen WebM.
- Generate the combined legacy-sidebar panel used by both Pages and the README.
- Use normal product commands for recordings that change state.
- Commit dark Ocean output. Generate light output for each recipe that enables it.
- Meet the approved size, duration, accessibility, privacy, and manifest checks.
- Use only synthetic fixture identities and paths.

Replace stable output files. Do not retain raw browser recordings or historical copies in the working tree.

<!-- ticket -->

# Record and approve the local-nightly desktop media

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the capture system and local-nightly page exist.

## Acceptance

- Use the isolated packaged app and fake update helper. Never run a real nightly build for the recording.
- Create the approved local-nightly poster and one short native desktop recording.
- Use dark Ocean for launch. Add a light recording later only if it adds useful information.
- Use Cap only after the maintainer approves capture and upload.
- Record the Cap license basis checked on the capture date.
- Require a maintainer pixel review before committing or uploading the media.
- Add controls, no autoplay, a poster, and a written sequence or transcript.
- Register the stable README output and license information.
- Keep raw Cap projects local under the approved retention limits.

One useful recording is enough. Do not add a second native capture path unless the first one cannot document the flow.

<!-- ticket -->

# Add freshness validation and the required docs pull-request check

## Target

Implement this ticket in `lastobelus/lastcode-docs` after the first content and media set exists.

## Acceptance

- Add one repository command and one GitHub check named `docs / validate`.
- Check the covered LastCode commit, registry hash, affected feature IDs, acknowledgements, docs evidence, and enabled capture commits.
- Check page structure, internal links, media, privacy patterns, accessibility, README references, vendored-skill hashes, frozen dependencies, focused tests, and the production build.
- Report external-link failures as warnings.
- Enforce the approved media and repository budgets.
- Require one maintainer approval, dismiss it after a push, disable auto-merge, and block Merge until `docs / validate` passes.
- Seed the first freshness record against the shared LastCode release commit.
- Do not generate or rewrite captures in GitHub CI.

This check protects publication. It does not promise continuous freshness, security, uptime, or concurrent-writer safety.

<!-- ticket -->

# Add the managed documentation-update process

## Target

Implement this ticket in `lastobelus/lastCode` after the docs capture and validation commands exist.

## Acceptance

- Run the docs update as a sibling of the checkpoint process. A docs failure must not block or roll back a checkpoint, build, or promotion.
- Use one guarded docs checkout, one durable docs thread, one fixed branch, and one open pull request.
- Send the exact LastCode commit range, affected feature IDs, and bounded changed paths to the docs thread.
- Coalesce a change that arrives during active work into a later turn.
- Verify the pull-request branch freshness record before reporting completion.
- Keep only active request, wait correlation, and incident-delivery data locally.
- Test a no-op range, a relevant range, an overlapping arrival, an agent failure, and a docs-validation failure.
- Commit no machine names, checkout paths, thread IDs, schedules, or private endpoints.

Only one machine runs this process. Start with one owner and one pending-update slot. If implementation or PR review keeps finding coordination bugs, remove automatic overlap handling or serialize the step before adding locks, queues, leases, or distributed state.

<!-- ticket -->

# Publish the first LastCode Pages release

## Target

Implement this ticket in `lastobelus/lastcode-docs` after validation and the managed updater are ready.

## Acceptance

- Deploy the production VitePress artifact from docs `main` to the `github-pages` environment.
- Run the same frozen validation command before deployment.
- Retain the deployment artifact for one day.
- Smoke-check the home page, all ten launch routes, and every registered README media URL at `https://lastobelus.github.io/lastcode-docs/`.
- Leave the previous site live when a build or deployment fails.
- Report a failed deployment through the existing docs incident path.
- Do not add a preview service, deployment database, rollback system, `gh-pages` branch, or committed build output.

Retry the workflow or publish a follow-up change when deployment fails. Do not build a separate release controller.

<!-- ticket -->

# Activate the generated LastCode README feature block

## Target

Implement this ticket in `lastobelus/lastCode` only after the Pages routes and media URLs work publicly.

## Acceptance

- Generate the exact approved five-feature README block from `docs/lastcode/features.json`.
- Include no more than two theme-aware Ocean panels from the stable capture paths.
- Use only `<picture>` sources that resolve publicly.
- Keep the shorter static risk warning immediately after the generated block.
- Add the LastCode CI check that proves regenerating the delimited block has no diff.
- Verify every feature link and media URL against the published Pages site.

The README generator owns only its delimited block. Do not add a general README templating system.
