> Historical research from August 2026, preserved at the maintainer's request.
> This snapshot describes proposals and the original implementation order.
> Current status and follow-up belong in the linked GitHub issues.
> See the [research index](README.md) before treating any proposal as implemented.

## Decision

Use MIT for the repository's original software and CC BY 4.0 for its original public documentation and media.

This lets people reuse the site code without friction and reuse the writing or demonstrations with clear attribution. CC BY 4.0 permits copying and adaptation, including commercial reuse, while requiring credit, a license link, and an indication of changes. The MIT license requires preservation of its copyright and license notice.

## Files and boundaries

The repository will contain these top-level files:

- `LICENSE.md`: the authoritative plain-language scope map and attribution instructions.
- `LICENSES/MIT.txt`: the unmodified MIT license text.
- `LICENSES/CC-BY-4.0.txt`: the unmodified CC BY 4.0 legal text.
- `THIRD_PARTY_NOTICES.md`: provenance and notices for copied assets and vendored material.

CC BY 4.0 covers original material in:

- `README.md`
- `docs/**/*.md`, except files below `docs/.vitepress/`
- `docs/public/media/**`

That includes original prose, screenshots, recordings, posters, captions, transcripts, and text alternatives. Site components and configuration below `docs/.vitepress/` remain MIT licensed. Capture recipes, manifests, validators, and generated-data machinery also remain MIT licensed.

The following exceptions keep their source licenses and are not relicensed under CC BY 4.0:

- LastCode or T3 Code brand assets copied into `docs/public/brand/**`
- LastCode or T3 Code interface elements visible inside screenshots and recordings
- vendored pstack skills, which retain their upstream MIT notice
- the vendored Playwright skill, which retains Apache-2.0 and its upstream `NOTICE`
- any other third-party material identified in `THIRD_PARTY_NOTICES.md`

The CC BY 4.0 grant applies to the capture, composition, annotation, narration, captions, and other original contributions to a media file. Underlying product artwork and interface elements retain their source license. An original recording hosted on Cap is designated CC BY 4.0 in its manifest entry and Cap description. A recording from any other source is not relicensed merely because the site embeds it.

## Attribution and contributions

`LICENSE.md` will give this preferred attribution form for CC BY material:

> LastCode documentation contributors, “Title,” LastCode documentation, CC BY 4.0, https://github.com/lastobelus/lastcode-docs. Changes were made.

Contributions use the license assigned to their destination path. `CONTRIBUTING.md` will say this directly. Contributors retain copyright in their work and submit it under the applicable license. The project will not add a CLA or DCO for the first release.

No license grants rights to the LastCode or T3 Code names, logos, or other trademarks. The site uses those names to identify the documented software and must not imply endorsement.

## Repository presentation

GitHub may not display a single license badge because repositories with multiple licenses are not always classified clearly. Accurate scope is more useful here than a misleading badge. The README will therefore state:

> Site code is MIT licensed. Original documentation and media are licensed under CC BY 4.0. Copied and vendored material retains its original license. See `LICENSE.md`.

The automated vendored-skill check will also require the relevant license and notice files. The media manifest will identify copied product assets and external embeds so an asset cannot silently cross a licensing boundary.

## Sources

- [Creative Commons Attribution 4.0 deed](https://creativecommons.org/licenses/by/4.0/)
- [Creative Commons Attribution 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode.en)
- [MIT license summary and text](https://choosealicense.com/licenses/mit/)
- [SPDX license identifiers](https://spdx.org/licenses/)
- [GitHub guidance for repository licenses](https://docs.github.com/en/enterprise-cloud@latest/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

## Effect on implementation

The repository bootstrap ticket owns these license files, copied notices, and contribution guidance. The site-shell ticket puts copied brand assets only under `docs/public/brand/`. The media tooling records source-license exceptions in the manifest and validates that every exception has a notice.
