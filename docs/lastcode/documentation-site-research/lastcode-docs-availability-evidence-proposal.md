> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

## Recommendation

Keep product availability and documentation evidence as separate facts, then join them into one generated table.

- LastCode's `docs/lastcode/features.json` says which clients the product supports.
- `lastcode-docs` records what its pages cover, how each client was verified, and which captures demonstrate it.
- The public site renders both. It never turns “not verified” into “not available,” and it never treats a screenshot as proof that a behavior works.

## Docs-owned evidence

Add a versioned `docs-evidence.json` file to `lastcode-docs`. It names the feature and client from the product registry, then records:

- `coverage`: `full`, `mentioned`, or `none`
- `verification`: `automated`, `manual`, or `none`
- `checkedAgainst`: the LastCode commit used for the latest verification or explicit review
- `captureIds`: zero or more registered demonstrations
- `note`: required when coverage or verification is `none`

Captures remain in the existing media manifest. `captureIds` only links the evidence record to those entries.

Do not infer one client from another. A browser recipe verifies web. A desktop check verifies desktop. A mobile check verifies mobile. Shared implementation can reduce the work needed, but it does not merge the evidence.

## Public wording

Generate the feature availability table from the two sources:

| Product registry        | Docs evidence | Public result                                            |
| ----------------------- | ------------- | -------------------------------------------------------- |
| Client is supported     | Verified      | **Available** · Verified by an automated or manual check |
| Client is supported     | Not verified  | **Available** · Not yet verified by the docs project     |
| Client is supported     | Not covered   | **Available** · Not documented here yet                  |
| Client is not supported | No evidence   | **Not available**                                        |

Show capture evidence separately as “Demonstrated” rather than “Verified.” A screenshot or movie can explain a flow, but it does not prove the whole client works.

The first-release mobile rule is therefore straightforward: where the LastCode registry includes mobile, the page says **Available · Not yet verified by the docs project**. It does not show mobile screenshots, instructions, or a tested claim. Where the registry does not include mobile for a feature, the page says **Not available**.

## Freshness rules

The validator checks these rules:

- Every registry feature and supported client has a docs evidence entry.
- Evidence cannot invent a client or mark an unsupported client as verified.
- Every capture ID exists in the media manifest and names the same feature and client.
- An automated verification points to a passing pinned check or recipe at `checkedAgainst`.
- A manual verification records maintainer approval at `checkedAgainst`.
- A capture by itself cannot set `verification`.
- When a relevant LastCode change affects a feature, the update pull request must refresh or explicitly review that feature's evidence against the target commit.
- Unaffected evidence may remain at its prior commit. Age alone does not make it stale.
- `verification: none` is valid when it has a plain-language note. It does not fail CI.

The freshness record continues to name the newest covered LastCode commit for the site as a whole. `checkedAgainst` records when the specific client evidence was last established. This avoids pretending that every client was retested after an unrelated change.

## First-release examples

- A deterministic browser flow for resumable actions can mark web as automated and demonstrated.
- A maintainer can mark desktop as manually verified without producing a second copy of the same visual.
- Mobile remains supported but unverified where the registry says the feature is available there.
- The local-nightly feature can mark desktop as manually verified and demonstrated by its approved native recording. Web and mobile remain not available if the product registry excludes them.

## Effect on implementation

- The registry ticket defines product-supported clients only.
- The capture-system ticket adds the docs evidence schema and joins it to the media manifest.
- The writing tickets generate availability blocks from the joined data instead of repeating availability in prose.
- The validation ticket enforces the cross-repository join and freshness rules.
- The updater refreshes evidence only for affected features, while still rerunning every enabled automated capture as already approved.

## Complexity limit

Start with one checked-in JSON file and one pure join with the product registry. Do not add a database, lock service, event stream, background reconciler, or real-time consistency promise.

This workflow serves one maintainer and publishes documentation for a small open source project. It has no uptime, reliability, or security guarantee. CI should catch stale claims before publication, but it does not need to make concurrent updates foolproof.

If implementation or review repeatedly exposes races and edge cases, simplify first. Reduce evidence detail, make a step manual, or remove automation that costs more than it saves. Add coordination machinery only after a concrete failure shows that the simpler process cannot work.
