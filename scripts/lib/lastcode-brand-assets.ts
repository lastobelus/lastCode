import { BRAND_ASSET_PATHS, type IconOverride, type WebAssetBrand } from "./brand-assets.ts";

export const LASTCODE_BRAND_ASSET_PATHS = {
  ...BRAND_ASSET_PATHS,
  developmentIosIconPng: "assets/lastcode/dev/app-icon-ios-1024.png",
  developmentUniversalIconPng: "assets/lastcode/dev/app-icon-universal-1024.png",
  developmentDesktopIconPng: "assets/lastcode/dev/app-icon-macos-1024.png",
  developmentWindowsIconIco: "assets/lastcode/dev/app-icon-windows.ico",
  developmentWebFaviconIco: "assets/lastcode/dev/favicon.ico",
  developmentWebFavicon16Png: "assets/lastcode/dev/favicon-16x16.png",
  developmentWebFavicon32Png: "assets/lastcode/dev/favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/lastcode/dev/apple-touch-icon-180.png",

  nightlyIosIconPng: "assets/lastcode/nightly/app-icon-ios-1024.png",
  nightlyMacIconPng: "assets/lastcode/nightly/app-icon-macos-1024.png",
  nightlyLinuxIconPng: "assets/lastcode/nightly/app-icon-universal-1024.png",
  nightlyWindowsIconIco: "assets/lastcode/nightly/app-icon-windows.ico",
  nightlyWebFaviconIco: "assets/lastcode/nightly/favicon.ico",
  nightlyWebFavicon16Png: "assets/lastcode/nightly/favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/lastcode/nightly/favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/lastcode/nightly/apple-touch-icon-180.png",

  productionIosIconPng: "assets/lastcode/prod/app-icon-ios-1024.png",
  productionMacIconPng: "assets/lastcode/prod/app-icon-macos-1024.png",
  productionLinuxIconPng: "assets/lastcode/prod/app-icon-universal-1024.png",
  productionWindowsIconIco: "assets/lastcode/prod/app-icon-windows.ico",
  productionWebFaviconIco: "assets/lastcode/prod/favicon.ico",
  productionWebFavicon16Png: "assets/lastcode/prod/favicon-16x16.png",
  productionWebFavicon32Png: "assets/lastcode/prod/favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/lastcode/prod/apple-touch-icon-180.png",
} as const;

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const LASTCODE_WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: LASTCODE_BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: LASTCODE_BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: LASTCODE_BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: LASTCODE_BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: LASTCODE_BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: LASTCODE_BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: LASTCODE_BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: LASTCODE_BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: LASTCODE_BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: LASTCODE_BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: LASTCODE_BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: LASTCODE_BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveLastCodeWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = LASTCODE_WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const LASTCODE_DEVELOPMENT_ICON_OVERRIDES = resolveLastCodeWebIconOverrides(
  "development",
  "dist/client",
);
