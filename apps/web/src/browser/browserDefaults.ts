import {
  DEFAULT_BROWSER_PROFILE_ID,
  PreviewAutomationProfileError,
  type PreviewAutomationOpenInput,
  resolveBrowserProfiles,
  type BrowserProfile,
  type DesktopPreviewTabDefaults,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
} from "~/hooks/useSettings";

import { resolveResponsiveBrowserViewportSize } from "./browserViewportLayout";

export interface BrowserDefaults {
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly appearance: PreviewAppearancePreference;
  readonly autoShowFloatingPreview: boolean;
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly profileId: string;
}

const toBrowserDefaults = (settings: {
  readonly browserDefaultViewport: PreviewViewportSetting;
  readonly browserDefaultZoomFactor: number;
  readonly browserDefaultAppearance: PreviewAppearancePreference;
  readonly browserAutoShowFloatingPreview: boolean;
  readonly browserProfiles: ReadonlyArray<BrowserProfile>;
  readonly browserDefaultProfileId: string;
}): BrowserDefaults => {
  const profiles = resolveBrowserProfiles(settings.browserProfiles);
  return {
    viewport: settings.browserDefaultViewport,
    zoomFactor: settings.browserDefaultZoomFactor,
    appearance: settings.browserDefaultAppearance,
    autoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
    profiles,
    profileId:
      profiles.find(
        (profile) =>
          profile.id === settings.browserDefaultProfileId && profile.kind !== "incognito",
      )?.id ?? DEFAULT_BROWSER_PROFILE_ID,
  };
};

export function getBrowserDefaults(): BrowserDefaults {
  return toBrowserDefaults(getClientSettings());
}

/**
 * Opening a preview is asynchronous anyway, and before hydration the snapshot
 * is the schema defaults rather than the user's — a tab opened in that window
 * would be born at the wrong viewport, zoom and appearance and never corrected.
 * Read failures reject so a new tab cannot use the wrong profile or viewport.
 */
export async function resolveBrowserDefaults(): Promise<BrowserDefaults> {
  await ensureClientSettingsHydrated();
  return getBrowserDefaults();
}

export function useBrowserDefaults(): BrowserDefaults {
  return useClientSettings(toBrowserDefaults);
}

export function browserDefaultTabState(
  defaults: BrowserDefaults = getBrowserDefaults(),
): DesktopPreviewTabDefaults {
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance };
}

export function browserDefaultOpenViewport(
  defaults: BrowserDefaults = getBrowserDefaults(),
): PreviewViewportSetting {
  return defaults.viewport;
}

export function browserDefaultOpenProfileId(
  defaults: BrowserDefaults = getBrowserDefaults(),
): string {
  return defaults.profileId;
}

/** Explicit selection must resolve to an existing identity, never the fallback default. */
export function resolveBrowserOpenProfileId(
  input: Pick<PreviewAutomationOpenInput, "profileId" | "profileName">,
  defaults: BrowserDefaults,
): string | undefined {
  if (input.profileId === undefined && input.profileName === undefined) return undefined;
  const matches = defaults.profiles.filter((profile) =>
    input.profileId !== undefined
      ? profile.id === input.profileId
      : profile.name === input.profileName,
  );
  if (matches.length === 0) {
    throw new PreviewAutomationProfileError({
      reason: "unknown",
      detail: `Browser profile ${JSON.stringify(input.profileId ?? input.profileName)} does not exist on this desktop. Call preview_profiles to list available profiles.`,
    });
  }
  if (matches.length > 1) {
    throw new PreviewAutomationProfileError({
      reason: "ambiguous",
      detail: `Browser profile name ${JSON.stringify(input.profileName)} matches multiple profiles. Use profileId: ${matches.map((profile) => JSON.stringify(profile.id)).join(", ")}.`,
    });
  }
  return matches[0]!.id;
}

export const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

export function browserResponsiveViewportForToggle(input: {
  readonly defaults?: BrowserDefaults;
  readonly panelRect: { readonly width: number; readonly height: number } | null;
  readonly zoomFactor: number | undefined;
}): PreviewViewportSetting {
  const defaults = input.defaults ?? getBrowserDefaults();
  if (defaults.viewport._tag !== "fill") return defaults.viewport;
  const size = input.panelRect
    ? resolveResponsiveBrowserViewportSize(input.panelRect, input.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  return { _tag: "freeform", ...size };
}
