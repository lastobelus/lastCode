# Legacy Sidebar Scaling Plan

## Outcome

Add a LastCode-only **Scale legacy sidebar** preference that lets a user render the
legacy sidebar at any whole-number scale from 50% through 100%. The default is 100%,
which is visually equivalent to the current T3 Code sidebar. A
visible 75% tick marks the normalized replacement for the user's current console CSS
patch.

The preference is client-local and durable. It applies to the legacy sidebar on web
and desktop clients, persists through the existing client-settings store, and does
not affect the current sidebar or the mobile client.

## Product Decisions

- Put the control in **Settings -> LastCode** and include it in settings search.
- Use a range slider with whole-number values from 50% through 100%, a live numeric
  output, and an explicitly labeled 75% reference tick.
- Treat the percentage as a literal geometric scale for the project and thread tree.
  At 75%, its text, icons, spacing, rows, controls, and hit targets render at 75%
  of their stock dimensions.
- Keep the LastCode header, Search field, Projects heading, drafts, status notices,
  and footer at standard size. Apply layout-aware CSS zoom to each project header
  and thread list while leaving sortable project containers unscaled, so the
  surrounding chrome, scroll bounds, and drag coordinates remain intact.
- Keep Electron's window zoom independent. View -> Actual Size / Zoom In / Zoom Out
  continues to scale the whole application outside the legacy-sidebar tree, so
  the two factors compose instead of replacing or resetting one another.
- Do not preserve or translate the old selector-specific CSS patch. This first
  version intentionally tests normalized literal scaling and can be revisited if the
  75% result is not visually satisfactory.

## Implementation

1. Add a bounded integer `legacySidebarScale` client setting and exported min,
   maximum, reference, and default constants in `packages/contracts`. Default to 100
   during decoding so existing settings files migrate without a compatibility path,
   and accept the field in client settings patches.
2. Extend the LastCode settings page with the searchable slider, output, 75% tick,
   reset action, and client-settings update path. Reuse the existing settings-slider
   styling and persistence rather than adding LastCode-specific IPC or storage.
3. Apply a layout-aware scaling surface to each rendered project header and thread
   list. Derive its CSS zoom from the persisted percentage with a pure helper that
   can be tested independently. Keep the sortable project item outside that surface
   so drag transforms use unscaled coordinates, and do not place the header, Search
   field, Projects heading, drafts, notices, or footer inside it.
4. Add focused tests for schema defaults and bounds, scale-style geometry, settings
   search routing, and desktop client-settings persistence fixtures.
5. Update this plan with implementation and validation results before handoff.

## Scope Boundaries

- No changes to the standard/current sidebar.
- No mobile UI or mobile preference mirror.
- No changes to Electron menu roles, browser preview zoom, or global app zoom state.
- No per-selector density tuning or compatibility support for the pasted style-tag
  IDs beyond selecting the project/thread tree as the scaling boundary.
- No server-authoritative or cross-device synchronization; the existing client-local
  settings contract is the persistence boundary.

## Validation

- Run focused contract, scaling-helper, settings-search, and desktop settings tests.
- Run targeted typechecks for `@t3tools/contracts`, `@t3tools/web`, and
  `@t3tools/desktop`.
- Run `git diff --check` and the LastCode pre-push quick-CI gate.
- Complete one bounded implementation review over correctness, UI/component design,
  KISS, UX/accessibility, and repository best practices.
- With permission for browser use, capture PR evidence showing 100% and 75% legacy
  sidebar states and manually verify slider persistence plus composition with View ->
  Actual Size / Zoom In / Zoom Out. If browser permission is not granted, report
  those checks as pending rather than claiming visual acceptance.

## Acceptance Criteria

- Existing users decode to and see 100% without a visible sidebar change.
- The setting accepts and persists every integer from 50 through 100 and rejects
  out-of-range or fractional stored values.
- The LastCode settings page exposes a keyboard-accessible slider with current value,
  reset behavior, and a visible 75% reference tick.
- The setting affects only the legacy sidebar and updates it without an app restart.
- At 75%, legacy project and thread rows are rendered at a literal 0.75 scale while
  the header, Search field, Projects heading, drafts, notices, and footer remain at
  standard size.
- Electron's View zoom commands remain implemented solely by the existing main-window
  zoom path and continue to compose with the sidebar scale.

## Results

Implementation is complete on `lastcode/legacy-sidebar-scaling`:

- Added the bounded client setting, LastCode slider/search entry, project-tree-only
  scaling surface, and focused contract/geometry/search/persistence coverage.
- Focused validation passed: 57 tests across contracts, web, and desktop; targeted
  contract, web, and desktop typechecks; formatting; and `git diff --check`.
- One bounded 5.6 Sol review found that flex shrinking could cancel the original
  inverse height, and the same reviewer marked that correction clean. Browser QA
  then showed that scaling the full surface distorted the LastCode header. The
  scaling boundary now excludes all sidebar chrome and uses layout-aware CSS zoom
  on project headers and thread lists while keeping sortable containers unscaled;
  focused coverage still spans 50%, 75%, and 100%.
- The first full quick-CI attempt passed formatting/lint and all workspace typechecks,
  then had one unrelated server test fail on a temporary loopback `ECONNRESET`. The
  exact failing test passed immediately in isolation. The exact-head pre-push rerun
  then passed the complete quick-CI gate, including all workspace tests.
- An earlier commit was pushed to `origin/lastcode/legacy-sidebar-scaling` after that
  green gate. The final corrected commit remains to be amended and repushed.
- Browser QA at the 75% reference value confirmed that the LastCode header,
  Search field, and Projects heading remain unscaled; the user accepted the
  resulting layout. The project/thread rows remain the only scaled content.
- Focused validation after the final scaling-boundary correction passed all 57
  selected tests, contracts/web/desktop typechecks, formatting, and
  `git diff --check`.
- Exact-head review identified two delivery gaps: importing T3 client settings could
  reset the LastCode-only scale, and shipped user documentation was missing. The
  import now preserves the destination scale, its integration test covers a retained
  75% value, and `docs/user/thread-sidebar.md` documents the control, persistence,
  scope, and desktop zoom composition.
- Electron zoom-composition QA will use the normal post-merge LastCode revision
  nightly, per the user's requested install sequence. Final exact-head review, full
  CI, and guarded merge remain pending.
