> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

# Proposed freshness, review, and publishing gates

## Require one automated check before merge

Every pull request to `lastcode-docs` runs the repository's validation command in GitHub Actions. GitHub shows the result as a check named `docs / validate` and disables the Merge button until the check passes.

That check runs every automated validation listed below. It inspects the screenshots and videos already committed to the pull request. It does not create or rewrite them.

Keep the automation pull request in draft until the command passes and every manual-media decision is recorded. Require one maintainer approval, dismiss the approval after a new push, and keep auto-merge off. Merging is the publication decision.

## Define stale by product impact

Age does not make a page stale. An unprocessed LastCode change does.

The committed freshness record names:

- the covered LastCode commit;
- the SHA-256 hash of `docs/lastcode/features.json` at that commit;
- every affected feature ID from the covered commit range;
- whether each affected feature was updated or reviewed with no documentation change.

The covered commit must descend from the prior covered commit. CI checks out the named LastCode commit, recomputes the registry hash and affected feature IDs, and rejects missing or extra acknowledgements.

If a commit range changes neither the registry nor a registered literal source prefix, the docs remain current. The updater does not open a freshness-only pull request. The next relevant update compares from the last recorded commit.

When a relevant change starts an update, rerun every enabled automated capture recipe against the target commit. There are only a few launch recipes, and deterministic outputs replace the same stable paths. This keeps the capture rule obvious and preserves the earlier media decision without adding a dependency graph.

An affected manual Cap recording remains stale until a maintainer replaces it or records `reviewedAgainst: <target-commit>` in its manifest entry.

## Block on deterministic checks

| Area                      | Blocking checks                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freshness                 | The freshness schema passes. The covered commit and registry hash resolve. The commit only advances. The recomputed impact set matches the recorded acknowledgements. Every enabled automated recipe records the target commit.                                                          |
| Pages and prose structure | Formatting, Markdown lint, spelling with a small project dictionary, frontmatter, heading order, route inventory, feature IDs, and registry references pass. Registry-owned titles, summaries, and availability data are generated rather than copied into authored prose.               |
| Links                     | The production build resolves every internal route, anchor, image, video, README media URL, and `/lastcode-docs/` base path. External-link failures appear as warnings because remote outages and rate limits are not repository failures.                                               |
| Media                     | Every manifest output exists, matches its content hash, stays within its size and duration budget, and decodes in pinned Chromium. Reject unregistered and orphaned media. Require each enabled appearance. Dark is required at launch; light becomes required when a recipe enables it. |
| Privacy                   | Capture only public synthetic fixtures. Reject pairing fragments, token patterns, maintainer paths, and identities outside the fixture allowlist in URLs, manifests, generated text, and logs. A reviewer checks the pixels because CI does not use OCR.                                 |
| Accessibility             | Informative stills have alt text. Every movie has a poster, controls, no autoplay, and a written sequence or transcript. Serious and critical axe findings block. A reviewer checks whether the text explains the visual result.                                                         |
| README                    | LastCode's product check proves that its registry is valid and regenerating the delimited README block produces no diff. Docs validation checks that every registry page and README panel ID resolves at the covered commit. Docs CI never rewrites or pushes LastCode.                  |
| Repository                | Frozen dependency installation, vendored-skill hashes and licenses, type checks, focused validator tests, the VitePress production build, the built-site crawl, and the axe crawl pass.                                                                                                  |

Do not add an automated Unslop or Technical Writing score. Agents apply those skills, and the maintainer reviews voice, claims, and instructions.

## Use smaller media budgets than GitHub's ceilings

GitHub caps a published Pages site at 1 GB, blocks individual Git files above 100 MiB, and does not support Git LFS for Pages. A Pages deployment times out after 10 minutes. Those limits are too large to protect page load time or make a media diff pleasant to review.

Start with these checked budgets:

| Item                                |                Budget |
| ----------------------------------- | --------------------: |
| PNG screenshot or poster            |                 2 MiB |
| Automated WebM                      |  8 MiB and 30 seconds |
| Committed human-approved MP4        | 20 MiB and 60 seconds |
| Current committed public media      |               100 MiB |
| Complete built Pages site           |               150 MiB |
| Current tracked source tree         |               250 MiB |
| Any committed file                  |      Less than 50 MiB |
| Packed Git history                  |       Warn at 400 MiB |
| One local raw Cap project           |                 2 GiB |
| All retained local raw Cap projects |                 5 GiB |

Warn when an individual media file reaches 75 percent of its budget. A deliberate exception changes the checked-in budget in the same reviewed pull request.

Commit only accepted PNG, WebM, and optional MP4 output. Replace stable files in place and remove superseded files from the current tree. Keep the latest accepted Cap project for each manual scene. Move its predecessor to the Trash 30 days after the replacement publishes. Raw browser recordings are disposable after validation, and raw Cap projects never enter Git.

Keep Pages deployment artifacts for one day. Keep optional pull-request previews and failed-capture diagnostics for seven days. Do not upload a duplicate site artifact unless a reviewer needs it.

Git history is the media archive. The scheduled maintenance run reports packed history above 400 MiB, but it does not block an unrelated documentation fix. A maintainer can then decide whether future large video belongs on Cap.

GitHub documents the current [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [repository file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github), [Actions limits](https://docs.github.com/en/actions/reference/limits), and [artifact retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization).

## Make human review specific

The pull-request body lists the target LastCode range, affected feature IDs, changed pages, regenerated media, manual-media decisions, budget warnings, and external-link warnings.

The maintainer checks:

- every changed claim and instruction against the named LastCode commit;
- every changed image and movie for truthful state, useful framing, and private information;
- alt text and written movie descriptions;
- affected pages in light and dark Ocean;
- the README panels and feature links;
- each acknowledged external-link warning;
- any Cap recapture or `reviewedAgainst` decision.

## Deploy the checked commit

A push to docs `main` runs the same frozen validation command, builds once, uploads the VitePress artifact, and deploys it to the `github-pages` environment. The workflow then checks the home page, all ten launch routes, and registered README media at `https://lastobelus.github.io/lastcode-docs/`.

A failed build leaves the prior Pages deployment live. A failed deployment or smoke check creates a docs incident. Retry the workflow or land another docs pull request. Do not add a preview service, deployment database, lock, queue, rollback system, `gh-pages` branch, or committed build output.

## Keep LastCode independent

The LastCode checkpoint and docs-update processes have separate results, logs, retries, and alerts. No LastCode checkpoint, build, or promotion job depends on docs validation or Pages deployment. Docs CI never reports a required status to LastCode and never rolls back a LastCode revision.

LastCode owns the registry and generated README consistency check. `lastcode-docs` owns site freshness, media validation, review, and publication.
