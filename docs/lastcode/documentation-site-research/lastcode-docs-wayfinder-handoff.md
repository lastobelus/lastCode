> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

## Wayfinder complete

The route to the first LastCode documentation release is specified. The final decision, [Define public feature-availability evidence](https://github.com/lastobelus/lastCode/issues/151), keeps product support separate from docs testing and capture evidence. Mobile can be available without a docs verification claim.

The plan now carries an explicit complexity limit. This process serves one maintainer on an open source project with no reliability or security guarantee. When implementation or pull-request review repeatedly finds races or edge cases, simplify the workflow before adding state, locks, queues, or coordination.

## Implementation order

Start these two tickets together:

- [Create the lastcode-docs repository and its project-local skills](https://github.com/lastobelus/lastCode/issues/152)
- [Add the LastCode public feature registry and README generator](https://github.com/lastobelus/lastCode/issues/153)

Then build the two foundations:

- [Build the VitePress Ocean site shell](https://github.com/lastobelus/lastCode/issues/154)
- [Add synthetic public-doc fixtures and a capture entry point](https://github.com/lastobelus/lastCode/issues/155)

Add the capture system and write the first release pages:

- [Build the deterministic capture runner and media manifest](https://github.com/lastobelus/lastCode/issues/156)
- [Write the overview, installation, and resumable-actions pages](https://github.com/lastobelus/lastCode/issues/157)
- [Write the thread-tools, annotations, and legacy-sidebar pages](https://github.com/lastobelus/lastCode/issues/158)
- [Write the local-nightly and feature-availability pages](https://github.com/lastobelus/lastCode/issues/159)

Create and review the launch media:

- [Generate the first automated Ocean capture set](https://github.com/lastobelus/lastCode/issues/160)
- [Record and approve the local-nightly desktop media](https://github.com/lastobelus/lastCode/issues/161)

Finish validation, upkeep, and launch in order:

- [Add freshness validation and the required docs pull-request check](https://github.com/lastobelus/lastCode/issues/162)
- [Add the managed documentation-update process](https://github.com/lastobelus/lastCode/issues/163)
- [Publish the first LastCode Pages release](https://github.com/lastobelus/lastCode/issues/164)
- [Activate the generated LastCode README feature block](https://github.com/lastobelus/lastCode/issues/165)

All tickets live in the LastCode tracker for now. Docs-targeted work still happens only in `lastcode-docs`, where its `AGENTS.md` will load the docs skill collection. Tracking an issue here does not put those skills or instructions into a LastCode branch.
