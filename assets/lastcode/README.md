# LastCode brand assets

This directory owns LastCode artwork separately from the upstream T3 Code asset trees.
Keeping fork-specific sources and exports here limits merge conflicts while the fork tracks
upstream nightly releases.

- `shared/wordmark.svg` is the editable source for the sidebar wordmark.
- `shared/app-mark-temporary.svg` is the current temporary app mark, including its baked-in
  raster shadows.
- `dev/`, `nightly/`, and `prod/` are stable export targets for each release channel.

The three channel directories intentionally contain the same temporary artwork today. Replace
their files in place when channel-specific Icon Composer projects are ready; build scripts and
application code should not need to change. Mobile remains on the upstream Icon Composer projects
until LastCode has native composer projects of its own.

For the final app icons, keep the letter components on separate Icon Composer layers and recreate
their depth there. The checked-in temporary SVG remains useful as the visual reference and fallback.
