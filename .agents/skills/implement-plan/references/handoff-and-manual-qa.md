# Handoff And Manual QA

## Manual QA Applicability

Manual app QA applies when work changes:

- visible UI, copy, layout, themes, accessibility, responsive behavior
- Electron desktop update/install behavior
- mobile UI or gestures
- browser-visible routing or interaction
- workflows where acceptance depends on human judgement

Manual app QA usually does not apply for docs-only, backend-only, test-only,
script-only, CI-only, dependency-only, or skill-only changes.

When UI/manual QA applies:

1. Start the appropriate dev server or packaged app.
2. Use the Browser Use plugin/in-app browser for local web targets when useful.
3. For Electron/mobile flows, document exact local steps and any artifacts to inspect.
4. Capture what passed, what failed, and what remains unverified.

Canonical skip text:

`Manual app QA not run: no manual UI QA surface`

## Final Handoff

Include:

- summary of implementation
- code cleanup/consolidation performed
- validation commands and results
- review rounds/lenses and disposition totals
- commits pushed, when applicable
- remaining risks or deferred decisions
- manual QA steps and expected behavior, or the skip reason above
- direct links to plans, docs, and local artifacts

If a required review or validation step could not be completed for real, say so plainly.
