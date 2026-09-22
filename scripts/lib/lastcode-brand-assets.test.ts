import { describe, expect, it } from "vite-plus/test";

import {
  LASTCODE_BRAND_ASSET_PATHS,
  LASTCODE_DEVELOPMENT_ICON_OVERRIDES,
  resolveLastCodeWebIconOverrides,
} from "./lastcode-brand-assets.ts";

describe("lastcode-brand-assets", () => {
  it.each(["development", "nightly", "production"] as const)(
    "keeps %s exports under the fork-owned asset tree",
    (brand) => {
      const overrides = resolveLastCodeWebIconOverrides(brand, "dist/client");

      expect(overrides).toHaveLength(4);
      expect(
        overrides.every(({ sourceRelativePath }) =>
          sourceRelativePath.startsWith("assets/lastcode/"),
        ),
      ).toBe(true);
      expect(overrides.map(({ targetRelativePath }) => targetRelativePath)).toEqual([
        "dist/client/favicon.ico",
        "dist/client/favicon-16x16.png",
        "dist/client/favicon-32x32.png",
        "dist/client/apple-touch-icon.png",
      ]);
    },
  );

  it("keeps native composer projects upstream until LastCode replacements exist", () => {
    expect(LASTCODE_BRAND_ASSET_PATHS.developmentIconComposerProject).toBe(
      "assets/dev/app-icon.icon",
    );
    expect(LASTCODE_BRAND_ASSET_PATHS.nightlyIconComposerProject).toBe(
      "assets/nightly/app-icon.icon",
    );
    expect(LASTCODE_BRAND_ASSET_PATHS.productionIconComposerProject).toBe(
      "assets/prod/app-icon.icon",
    );
  });

  it("uses LastCode development icons for local server packages", () => {
    expect(LASTCODE_DEVELOPMENT_ICON_OVERRIDES[0]).toEqual({
      sourceRelativePath: LASTCODE_BRAND_ASSET_PATHS.developmentWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    });
  });
});
