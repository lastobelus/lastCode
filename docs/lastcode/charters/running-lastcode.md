---
area: running-lastcode
title: Running my own LastCode
tier: yield
paths:
  - scripts/lastcode-*
  - scripts/lib/lastcode-*
  - .github/workflows/lastcode-*
  - docs/lastcode/
  - apps/desktop/src/updates/LastCodeLocalUpdates.ts
  - apps/desktop/src/settings/LastCodeSettingsImport.ts
  - apps/web/src/components/settings/LastCodeLocalUpdatesSettings.tsx
  - apps/web/src/components/settings/LastCodeImportSettings.tsx
  - apps/web/src/components/branding/
  - apps/web/src/branding.logic.ts
  - scripts/apply-web-brand-assets.ts
  - scripts/lib/apply-web-brand-assets.ts
---

# Running my own LastCode

## Purpose

The owner runs their own build of LastCode, rebuilt on top of each upstream T3 Code nightly. This area is what keeps that build current, checked and installable, and what makes it recognisably LastCode while it runs beside T3 Code. Where it only adjusts upstream's own code, upstream's way wins.

## Intents

### Local nightly updates and install

- LastCode can build and install its own nightly from a local checkpoint tag, without a hosted release, and only when the user opts in.
- Builds and installs never overlap, and a replacement app is validated before the running one quits.

### Checkpoints and carry replay

- Each upstream nightly gets a checkpoint: LastCode's carries replayed onto it, checked by CI, and published as a tag that is never rewritten.
- Each carry replays in its own group, so a conflict or failure is charged to the work that caused it.
- A failed checkpoint can be repaired and resumed without starting over.

### Local CI and PR gates

- The checks GitHub CI runs can run locally first, scoped to what changed.
- A LastCode PR merges only through the guarded merge, after its gates pass.

### Setup and settings import

- LastCode runs beside T3 Code with its own app identity, state home and URL schemes, and neither app changes the other's state.
- Importing T3 Code settings is a one-time copy. It never brings over providers, secrets, threads or machine identity, and it backs up what it replaces.

### Appearance and branding

- LastCode's name, marks and icons replace T3 Code's on every client.
- LastCode-only appearance preferences, such as larger scrollbars, the sidebar choice and scale, and rounded project icons, survive upgrades and settings import.
