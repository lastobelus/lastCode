> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

# LastCode Pages visual prototype

Open [the standalone HTML prototype](./lastcode-docs-visual-prototype.html) to review the feature-page layout and cycle through system, light, and dark appearances.

## Design direction

- Extend VitePress's default theme rather than replacing it.
- Use the exact LastCode/T3 Code Ocean palette for both appearances.
- Use the product font stacks: `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `system-ui`, `sans-serif`; and `ui-monospace`, `"SF Mono"`, `"SFMono-Regular"`, `Menlo`, `monospace`.
- Use the existing LastCode production mark on a neutral tile for the favicon and navigation. The current mark contains black artwork, so the tile prevents it disappearing against dark Ocean.
- Use Lucide only for functional interface icons such as search, external links, theme selection, and callout types. Feature identity comes from words and product captures, not decorative icon tiles.
- Keep surfaces flat, borders quiet, corners modest, and animation absent. Ocean blue is reserved for links, focus, the active sidebar row, and primary controls.

## Page layout

```text
┌──────────────────────────────── top navigation ────────────────────────────────┐
│ LastCode Docs     Install  Features  Understand  Reference  Search  Appearance │
├────────────────┬─────────────────────────────────────┬─────────────────────────┤
│ Start          │ Feature guide                       │ On this page            │
│ Features       │ Title and plain-language summary    │ Why it exists           │
│ Understand     │ Tested-surface metadata             │ Configure               │
│ Reference      │ Theme-matched product capture       │ While running           │
│                │ Why it exists                       │ Limits                  │
│                │ Numbered task steps                 │                         │
│                │ Behavior, limits, recovery          │                         │
│                │ Previous / next pages               │                         │
└────────────────┴─────────────────────────────────────┴─────────────────────────┘
```

At tablet width, the on-page outline disappears. At phone width, VitePress's navigation drawer replaces the persistent sidebar, availability metadata stacks, and content uses the full viewport.

## Reusable components

- `FeatureAvailability`: generated documented/tested surfaces, providers, platforms, status, and explicit exclusions.
- `FeatureMedia`: light/dark image or video selection, poster, caption, alt text, and transcript/description.
- Native VitePress steps, code blocks, callouts, table of contents, edit link, last-updated line, and previous/next navigation.
- No feature-card framework inside article pages and no bespoke page layouts per feature.

## Accessibility and behavior

- Follow system appearance by default and retain VitePress's explicit light/dark selector.
- Preserve visible keyboard focus and native link underlines in prose.
- Use an article width between 760 and 780 px and a 16 px base size.
- Respect `prefers-reduced-motion`; the docs theme introduces no ambient motion.
- Do not communicate status by color alone.
- Product movies use controls, never autoplay, and include a poster plus concise description or transcript.

## Scope

The prototype demonstrates a feature page because it is the repeated reader experience. The home page should reuse the same tokens and navigation, with a plain introduction, install link, one workspace capture, the five registry-generated feature summaries, and the risk boundary. It should not add a slogan, animated hero, gradient artwork, testimonials, or marketing metrics.
