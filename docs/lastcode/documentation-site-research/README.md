# Documentation-site research archive

This directory preserves the August 2026 research for the LastCode public
documentation site. The maintainer requested this archive before closing the
working conversation. The snapshots record the agreed design and original
implementation order. GitHub issues own current work and acceptance decisions.

The site and its documentation skills live in
[lastobelus/lastcode-docs](https://github.com/lastobelus/lastcode-docs). LastCode owns
the public feature registry, synthetic product fixtures, and the proposed update
trigger. Preserving research here does not install documentation skills or change
the product's agent instructions.

## Research snapshots

| Snapshot                                                                 | Subject                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [Wayfinder handoff](lastcode-docs-wayfinder-handoff.md)                  | Repository boundaries, complexity limit, and original work order.                |
| [Implementation backlog](lastcode-docs-implementation-backlog.md)        | Original acceptance criteria for issues #152 through #165.                       |
| [Skill collection](lastcode-docs-skill-collection-proposal.md)           | Required writing skills, reviewed upstream pins, licenses, and explicit updates. |
| [Freshness and publication](lastcode-docs-freshness-gates-proposal.md)   | Proposed validation, review, media budgets, retention, and deployment rules.     |
| [Availability evidence](lastcode-docs-availability-evidence-proposal.md) | Product support, documentation coverage, verification, and demonstrations.       |
| [License boundaries](lastcode-docs-license-proposal.md)                  | MIT site code, CC BY 4.0 public prose and media, and third-party exceptions.     |
| [Visual design notes](lastcode-docs-visual-prototype.md)                 | Ocean colors, typography, navigation, and feature-page layout.                   |
| [HTML design prototype](lastcode-docs-visual-prototype.html)             | The reviewed standalone layout with weight-600 headings and tinted cards.        |
| [README prototype](lastcode-readme-feature-prototype.md)                 | Five feature summaries and at most two shared Ocean panels.                      |

The proposals are historical records, not installed behavior or current package
instructions. For example, the availability proposal calls its evidence file
`docs-evidence.json`; the implemented docs repository uses `docs/evidence.json`.
The original skill proposal describes five skills. The later docs PR workflow
added another skill in the docs repository. Consult that repository for current
commands, dependencies, filenames, and skill pins.

The HTML prototype's navigation and search are placeholders. Its embedded product
artwork retains the LastCode repository's MIT license. The prototype is not part
of the public Pages build. Its appearance review does not establish product QA.

## Delivered work at the archive handoff

The docs repository bootstrap and project-local skills were delivered under
[issue #152](https://github.com/lastobelus/lastCode/issues/152).

LastCode merged these product foundations:

- [PR #167](https://github.com/lastobelus/lastCode/pull/167), public feature registry
  and inactive README generator.
- [PR #170](https://github.com/lastobelus/lastCode/pull/170), synthetic public-doc
  fixtures and isolated fake updater.
- [PR #177](https://github.com/lastobelus/lastCode/pull/177), the fixture projector
  cursor fix needed for recorded annotation commands.

The docs repository merged these milestones:

- [PR #1](https://github.com/lastobelus/lastcode-docs/pull/1), VitePress Ocean shell.
- [PR #2](https://github.com/lastobelus/lastcode-docs/pull/2), resumable PR waiter.
- [PR #3](https://github.com/lastobelus/lastcode-docs/pull/3), capture runner and
  media manifest.
- [PR #4](https://github.com/lastobelus/lastcode-docs/pull/4), overview,
  installation, and resumable-action guides.
- [PR #5](https://github.com/lastobelus/lastcode-docs/pull/5), thread tools,
  annotations, legacy sidebar, and command reference.
- [PR #6](https://github.com/lastobelus/lastcode-docs/pull/6), local-nightly and
  feature-availability pages.
- [PR #7](https://github.com/lastobelus/lastcode-docs/pull/7), the first automated
  dark Ocean capture set.

These merges do not complete the site release. The required freshness check,
managed updater, Pages launch, and README activation remain separate work.

## Follow-up ownership

| Issue                                                     | Work carried forward                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#161](https://github.com/lastobelus/lastCode/issues/161) | Local-nightly desktop media is deferred by the maintainer. The unapproved recording and poster are unavailable.                                                              |
| [#162](https://github.com/lastobelus/lastCode/issues/162) | Freshness validation and required `docs / validate` check. Includes enabling the docs project's PR Action from #172 and updating its readiness rules for the required check. |
| [#163](https://github.com/lastobelus/lastCode/issues/163) | LastCode-driven documentation updates and separate docs failure reporting.                                                                                                   |
| [#164](https://github.com/lastobelus/lastCode/issues/164) | Pages release, public route and media checks, and the deferred responsive-navigation and keyboard QA from #154.                                                              |
| [#165](https://github.com/lastobelus/lastCode/issues/165) | README activation after the public routes and required approved media resolve.                                                                                               |
| [#148](https://github.com/lastobelus/lastCode/issues/148) | Icon Composer sources and exports. The recovered original instructions are already in the issue.                                                                             |
| [#287](https://github.com/lastobelus/lastCode/issues/287) | Collaborative browser automation recovery.                                                                                                                                   |
| [#303](https://github.com/lastobelus/lastCode/issues/303) | Investigation of recurring macOS permission prompts despite granted permissions.                                                                                             |

The media attempt used a disposable packaged app and fake updater. On an Intel
capture machine, the disposable app's Apple Silicon guard was overridden for the
scene. That is not evidence that the shipped feature supports Intel. Cap capture
produced permission dialogs, so the final attempt captured the Electron renderer
directly. The replacement method still required maintainer approval.

The draft filenames were `local-nightly-renderer.mp4` and
`local-nightly-poster.png`. Neither file was available at the archive handoff.
No native recording was approved, committed, or uploaded. Any eventual replacement
must retain the fake-updater boundary, disclose capture-only overrides, and meet
the media approval and licensing requirements in #161. This archive does not
authorize new media work.

The docs local-CI Action remains conditional. Reassess it under #162 only if actual
validation repeatedly needs three or more waits. Mobile product QA and mobile
media remain deferred until the maintainer chooses to pursue them. The availability
model records an unverified supported client without claiming that it was tested.

The process serves one maintainer. If review repeatedly finds races or edge cases,
remove state or make a step manual before adding coordination machinery. Concrete
deployment wiring belongs outside public repositories.
