# LastCode Local Nightly Release Notes Plan

## Outcome

Make the LastCode local-nightly update hover card describe the actual update from
the installed build to the offered installable:

- show downstream-only LastCode changes once in a dedicated section;
- show upstream changes in one section per missed nightly, newest first;
- exclude LastCode commits that are merely replayed by checkpoint rebases or have
  become part of the target upstream nightly;
- preserve same-nightly LastCode-only revision updates; and
- keep hosted T3 Code update notes unchanged.

The result must be truthful even for long update ranges and older builds. It must
never label the whole rebased LastCode patch stack as new.

## Current Failure

`scripts/lastcode-local-update.mjs` currently runs one non-merge `git log` from
the installed installable tag to the latest checkpoint or revision, truncates the
combined result to 40 subjects, and returns a flat `releaseNotes` array. The
desktop wraps that array in one release-note group.

That range does not represent new work because checkpoints are rebased rather
than descended from one another. For the real `1113 -> 1124` range, Git reports
the replayed LastCode stack alongside the actual upstream delta. The global
40-item slice can then remove a real upstream subject while retaining replayed
fork subjects.

Hosted T3 Code does not have this problem: Electron Updater returns one release
record per missed GitHub nightly, and the existing normalizer preserves those
per-version groups.

## Product Contract

### Sections and ordering

1. Render one aggregate `LastCode changes` section first when there are new
   downstream-only LastCode changes.
2. Render `Upstream changes` for the newest target nightly.
3. Render `Upstream changes in <version>` for earlier missed nightlies, newest
   first.
4. Omit a known-empty LastCode section and omit empty upstream nightly groups.
5. A same-nightly LastCode revision may therefore show only `LastCode changes`.

### Meaning of a new LastCode change

A LastCode change is new when it entered `lastcode/main` after the source
snapshot represented by the installed build and is still a downstream-only
patch in the offered checkpoint or revision.

- A replayed commit with a new SHA is not new.
- A commit introduced after the installed snapshot is listed once, even if
  several missed checkpoints replayed it.
- A patch-equivalent change present in the target upstream nightly is listed
  only under upstream changes.
- An upstream contribution imported into LastCode remains a LastCode change
  while the offered checkpoint still carries it as a downstream-only patch.

Use Git patch equivalence for upstream adoption. Do not guess semantic equality
from titles or issue numbers.

### Missing provenance

If the exact installed checkpoint/revision tag is unavailable, its annotated
`Source-Commit` is absent, or no safe source boundary can be related to the
target source snapshot, do not guess which LastCode commits are new. Render a
`LastCode changes` section containing the non-bulleted message:

> Couldn’t determine changes from this installed build.

Upstream nightly grouping remains available because the installed version still
identifies its upstream nightly.

### Display bounds

- Show at most eight LastCode subjects, followed by
  `…and N more LastCode changes` when needed.
- Show at most six non-empty upstream nightly groups.
- Show at most eight subjects per upstream group, followed by
  `…and N more changes` when needed.
- Finish the oldest displayed upstream group with
  `N older nightlies not shown` when additional non-empty groups were omitted.

Overflow messages must be explicit and visually distinct from commit-subject
bullets. The hover card remains scrollable using its existing height limit.

### Source and scope

- Generate local upstream notes from non-merge commit subjects between exact,
  consecutive upstream nightly tags. Do not add a GitHub API or release-body
  dependency.
- Apply the new structure only to `lastcode-local` update results.
- Preserve hosted update parsing, headings, ordering, and current normalization
  behavior.
- Preserve update availability for revision versions such as
  `...nightly.<build>.1` when no upstream nightly changed.

## Design

### 1. Negotiate the helper response format

The installed app executes `scripts/lastcode-local-update.mjs` from the updated
repository before it can build and install the app containing the new decoder.
A hard response-shape cutover would strand that app.

Add an inspect-only format option, for example:

```text
inspect --release-notes-format grouped-v1
```

- Without the option, return the existing schema-version-1 flat response
  unchanged. This is the narrow bootstrap path for already-installed apps.
- With the option, return a new, versioned structured inspection response.
- Make `LastCodeLocalUpdates` in the new desktop build request and decode the
  structured format explicitly.
- Do not add automatic format probing, silent downgrade, or a second fallback
  protocol. The old default exists solely because it is active in the
  self-update lifecycle.
- Leave the helper's build command and build-result schema unchanged.

The structured result should carry semantic data rather than pre-rendered UI:

- LastCode provenance state (`known` or `unavailable`), subjects, and omitted
  item count;
- upstream groups with nightly version, subjects, and omitted item count; and
- the number of omitted non-empty upstream groups.

### 2. Resolve installable provenance from existing tags

Build a dependency-free helper layer in `scripts/lastcode-local-update.mjs` that
reads checkpoint and revision tags plus their annotated metadata.

For each relevant installable, resolve:

- parsed nightly and revision identity;
- installable commit;
- upstream tag and commit; and
- annotated `Source-Commit` when present.

Build the complete, version-ordered installable chain from the exact installed
tag through the target tag. Walk each adjacent checkpoint/revision edge rather
than comparing the installed tag directly with the target. Promotions and later
rebases can make those endpoints unrelated even though every intermediate edge
has valid provenance.

For each adjacent pair, reuse the checkpoint planner's ancestry invariant:

1. if both tags record the same `Source-Commit`, no LastCode source changes
   entered at that edge;
2. otherwise use the previous installable commit when it is an ancestor of the
   next tag's source snapshot;
3. otherwise use the previous tag's `Source-Commit` when that is an ancestor of
   the next source snapshot; and
4. otherwise mark LastCode provenance unavailable for the whole interval.

This handles both normal promotion and the open-PR/unpromoted revision path. It
also handles a checkpoint run that creates several missing nightlies from one
unchanged source snapshot: every tag from that run records the same
`Source-Commit`, so later replay edges contribute no new LastCode subjects.

Do not add checkpoint metadata in the initial implementation. Existing tags
already carry the source snapshot used by checkpoint and revision planning. If
focused tests against real tags disprove that invariant, stop and revise this
plan rather than adding speculative tracking.

### 3. Derive new downstream-only LastCode subjects

When provenance is known:

1. for each provenance edge that has a new source snapshot, enumerate non-merge
   commits in `<edge-boundary>..<next-source-commit>`;
2. combine those edge-local candidates in installable chronology without
   re-enumerating unchanged-source replay edges;
3. compare every candidate with the final target upstream tag using Git's stable
   patch equivalence (`git cherry` or an equivalently testable plumbing command);
4. retain only commits Git reports as absent from final target upstream;
5. order the retained subjects newest first across the full installed-to-target
   interval; and
6. apply the eight-item display bound while retaining the full count for the
   overflow message.

This source-snapshot comparison prevents old fork patches from becoming new
again after a rebase. The target-upstream comparison prevents a patch adopted
upstream from appearing in both sections.

If there are no retained commits, omit the LastCode section. If provenance is
unavailable, emit only the explicit unavailable state; do not fall back to the
target's entire fork stack.

### 4. Derive upstream nightly groups

Starting from the installed version's upstream nightly and ending at the target
installable's upstream nightly:

1. enumerate every upstream nightly tag in the interval;
2. sort the interval newest first for display;
3. for each nightly, compare it with its immediate predecessor from the complete
   upstream tag sequence, not merely the next displayed group;
4. collect non-merge commit subjects for that exact nightly interval;
5. omit empty groups before applying the six-group bound;
6. cap each retained group at eight subjects while preserving its full count;
   and
7. report how many additional non-empty nightly groups were omitted.

When the installed and target upstream nightly tags are equal, emit no upstream
groups. This leaves same-nightly revision updates intact.

### 5. Carry structured groups through desktop state

Update the local inspection schema in
`apps/desktop/src/updates/LastCodeLocalUpdates.ts` for the negotiated structured
response. Keep protocol decoding at this boundary so malformed helper output
fails as a local-update inspection error rather than leaking unknown data into
desktop state.

Map the structured local result in `DesktopUpdates` into the existing desktop
update state. Extend `DesktopUpdateReleaseNote` in `packages/contracts` only with
the minimal optional presentation data needed by local groups, such as:

- an explicit section heading; and
- zero or more summary/footer lines for unavailable and overflow messages.

Hosted groups leave those fields absent. The web renderer must continue deriving
their current `What’s changed` / `Changes in <version>` headings exactly as it
does today.

Local mapping rules:

- create `LastCode changes` only for known non-empty subjects or unavailable
  provenance;
- create explicit upstream headings from group position and version;
- format count-aware overflow summaries in the desktop/UI layer, not in Git
  plumbing; and
- preserve the groups through available, building/downloading, downloaded, and
  install-ready state transitions.

### 6. Render explicit local headings and summaries

Update `SidebarUpdatePill.tsx` to:

- prefer a group's explicit heading when present;
- retain the existing index-based hosted heading fallback;
- render summary/footer lines outside the commit-subject bullet list;
- keep separators and the current scroll container;
- use a stable key that does not collide when the LastCode and newest upstream
  groups share the same version; and
- preserve duplicate commit subjects within a group using the existing
  occurrence-aware item keys.

Do not change the update button, tooltip activation behavior, architecture
warning, download/build/install actions, or non-nightly presentation.

### 7. Update documentation

Update `docs/lastcode/local-nightly-updates.md` to describe:

- separate LastCode and per-nightly upstream sections;
- source-snapshot semantics and the provenance-unavailable message;
- explicit display bounds; and
- same-nightly LastCode revision updates.

Update `docs/lastcode/nightly-workflow.md` only where needed to document the
existing `Source-Commit` provenance contract and the helper's negotiated inspect
format. Do not describe the legacy flat response as the desired product model;
identify it narrowly as the installed-app bootstrap format.

## Test Plan

### Helper and Git topology

Extend `scripts/lastcode-local-update.test.ts` with synthetic annotated-tag
graphs that prove:

- two or more missed upstream nightlies produce newest-first groups bounded by
  consecutive upstream tags;
- an unchanged LastCode source snapshot produces no LastCode section after
  multiple rebases;
- a valid multi-checkpoint provenance chain remains known when the installed and
  target endpoints are not direct ancestors, including several checkpoints
  created from one shared `Source-Commit`;
- commits merged after the installed source snapshot appear once across several
  missed checkpoints;
- a same-nightly revision is available and contains only its new LastCode
  subjects;
- a patch-equivalent upstream adoption is removed from LastCode notes and
  remains in its upstream nightly group;
- an imported change remains in LastCode notes while it is downstream-only;
- missing installed tags, missing `Source-Commit`, and unrelated source history
  produce the unavailable state without suppressing accurate upstream groups;
- empty upstream groups are removed before the six-group bound;
- item and group overflow counts are exact; and
- an unflagged inspect call still returns the legacy flat schema required by the
  currently installed app.

Use small repository fixtures with explicit commit subjects, annotated metadata,
and rebases. Assertions must cover the full structured result rather than only a
few included fields.

### Desktop protocol and state

Extend focused coverage in:

- `apps/desktop/src/updates/LastCodeLocalUpdates.test.ts` for the negotiated
  argument and structured decoder;
- `apps/desktop/src/updates/DesktopUpdates.test.ts` for local group mapping and
  preservation through build/download state changes; and
- `packages/contracts/src/ipc.test.ts` for the minimal release-note presentation
  fields.

Retain and strengthen hosted coverage in
`apps/desktop/src/updates/releaseNotes.test.ts` and the hosted full-changelog
case in `DesktopUpdates.test.ts` so those outputs remain unchanged.

### Web presentation

Add focused presentation coverage for the sidebar update hover card, extracting
a small pure heading/presentation helper if that keeps the component test
bounded. Prove:

- LastCode appears before upstream;
- local explicit headings and non-bulleted summaries render correctly;
- two groups with the same version do not collide;
- hosted groups retain the current fallback headings; and
- scroll/separator classes remain present for multiple groups.

Do not introduce a general release-notes component framework for this change.

## Validation

1. Run the focused helper, desktop update, contract, and web presentation tests
   changed by this work.
2. Run targeted typechecks for `@t3tools/contracts`, desktop, and web plus
   targeted lint/format checks for edited files.
3. Run `git diff --check` and the LastCode quick-CI gate. Do not run repository-
   wide checks unless explicitly requested; full CI remains the PR gate.
4. Exercise the structured helper against real published checkpoint/revision
   tags, including a multi-nightly range and a same-nightly revision range, and
   compare its source classification with Git history.
5. With explicit computer-use permission, complete one packaged LastCode pass
   using real checkpoint topology. Capture a screenshot that proves section
   order, explicit headings, newest-to-oldest nightly grouping, scroll behavior,
   and overflow/unavailable presentation where applicable. Use an isolated,
   recoverable QA setup; do not point a test server at live T3 state or disrupt
   an unrelated running LastCode instance.
6. Record packaged QA as pending rather than complete if permission or a safe
   isolated setup is unavailable.

## Acceptance Criteria

- A user behind multiple upstream nightlies sees one upstream section per
  non-empty nightly, newest first, within the agreed explicit bounds.
- Rebased LastCode commits already represented by the installed build never
  reappear as new solely because their SHAs changed.
- New downstream-only LastCode commits appear once in `LastCode changes`.
- Patch-equivalent changes adopted by target upstream do not appear in the
  LastCode section.
- Same-nightly LastCode revisions continue to appear as available updates and
  can present a LastCode-only changelog.
- Missing installed provenance produces the explicit unavailable message and
  does not corrupt upstream grouping.
- No list or group is silently truncated.
- Hosted T3 Code release notes render exactly as before.
- An already-installed LastCode build can still inspect the updated repository,
  discover the implementation nightly, and bootstrap into the new structured
  protocol.
- Focused automated validation and the packaged visual acceptance pass are
  complete, or packaged QA is explicitly reported as pending for the bounded
  reasons above.

## Scope Boundaries

- No GitHub API or hosted release-body fetch for local notes.
- No semantic deduplication based on titles, PR numbers, or fuzzy matching.
- No new checkpoint metadata unless real-tag tests disprove the existing
  `Source-Commit` invariant and the plan is revised first.
- No change to checkpoint creation, promotion, revision availability, build
  selection, artifact construction, or installation behavior.
- No change to hosted update normalization or release-note content.
- No mobile surface; local nightly build/install is a packaged desktop feature.
- No general changelog persistence service or compatibility framework beyond
  the explicitly negotiated installed-app helper format.

## Results

- Implemented a negotiated grouped inspect response while retaining the
  unflagged flat response for installed-app bootstrap compatibility.
- Classified LastCode subjects across adjacent immutable installable tags,
  excluded replayed and target-upstream-equivalent patches, and returned an
  explicit unavailable state when source provenance is missing or unsafe.
- Grouped upstream subjects by consecutive nightly tags, omitted empty groups,
  and enforced the agreed item and group bounds with explicit omitted counts.
- Carried explicit headings and non-bulleted summaries through the desktop IPC
  contract and sidebar hover card without changing hosted release-note
  normalization.
- Added focused Git-topology, desktop-state, contract, and rendered-tooltip
  coverage. The focused suite passes with 44 tests; targeted lint and
  contracts/desktop/web typechecks pass, and `git diff --check` is clean.
- Exercised real published tags for a multi-nightly range and an isolated
  same-nightly `1120.3` to `1120.4` range. The latter remained available and
  contained exactly its one new LastCode subject with no upstream groups.
- Read-only external review is blocked: the prescribed Codex reviewer model is
  unsupported by the configured ChatGPT-backed CLI, and the configured Z.AI
  reviewer returns a server error even for an availability probe.
- Packaged visual QA passed in a signed Apple Silicon build with a unique QA
  bundle identity and isolated T3/LastCode state, using published checkpoint
  topology from `1113.6` through `1130`; the unrelated running LastCode app was
  left untouched.
- The packaged hover card showed `LastCode changes` before `Upstream changes`,
  rendered upstream nightly headings newest first, exposed `3 more LastCode
changes` and `3 older nightlies not shown` instead of silently truncating,
  and scrolled successfully to older nightly groups. Focused rendered coverage
  proves the explicit unavailable-provenance presentation for the topology
  where that state applies.
