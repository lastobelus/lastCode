import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  readThreadPreviewState,
  rememberPreviewUrl,
  setActivePreviewTab,
  type ThreadPreviewState,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentHasLocalDesktopBrowser } from "~/state/entities";

/**
 * Which open tab a foreground link may reveal instead of opening another.
 * `address`: the same address, or on a local host the same origin and path.
 * `origin`: any page on the same origin, for an entry point such as a hub index.
 * `none`: always a new tab, for an open that must load what it just started.
 */
export type PreviewTabReuse = "address" | "origin" | "none";

export interface PreviewTabPlacement {
  readonly profileId: string | undefined;
  readonly runtime?: PreviewRuntime | undefined;
  readonly desktopHostId?: string | undefined;
  readonly browserHost?: "environment" | undefined;
}

/** Loopback names and `*.localhost`, which Chromium resolves to the desktop's own loopback. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLoopbackHost(host) || host.endsWith(".localhost");
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function addressMatches(tab: URL, target: URL, reuse: PreviewTabReuse): boolean {
  if (tab.href === target.href) return true;
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (tab.origin !== target.origin) return false;
  if (reuse === "origin") return true;
  // The fragment stays: hash-routed apps keep their route there.
  return (
    isLocalHost(target.hostname) && tab.pathname === target.pathname && tab.hash === target.hash
  );
}

function samePlacement(tab: PreviewSessionSnapshot, target: PreviewTabPlacement): boolean {
  if (
    (tab.profileId ?? DEFAULT_BROWSER_PROFILE_ID) !==
    (target.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
  ) {
    return false;
  }
  if (target.runtime !== "server") return tab.runtime !== "server";
  if (tab.runtime !== "server") return false;
  return (
    tab.desktopHostId === (target.browserHost === "environment" ? undefined : target.desktopHostId)
  );
}

/**
 * The host a server open lands on. One naming no host goes to the environment's own desktop
 * browser when it has one, else its headless browser; null while that is not known yet.
 */
function resolvePlacement(
  environmentId: EnvironmentId,
  placement: PreviewTabPlacement,
): PreviewTabPlacement | null {
  if (
    placement.runtime !== "server" ||
    placement.browserHost === "environment" ||
    placement.desktopHostId !== undefined
  ) {
    return placement;
  }
  const localDesktopBrowser = readEnvironmentHasLocalDesktopBrowser(environmentId);
  if (localDesktopBrowser === undefined) return null;
  return localDesktopBrowser
    ? { ...placement, desktopHostId: "local" }
    : { ...placement, browserHost: "environment" };
}

/**
 * The reader-controlled tab to reveal for `urls`, or null. Agent-owned, hidden and closing
 * tabs never match. The active tab wins, then the most recently updated one.
 */
export function findReusablePreviewTab(
  state: ThreadPreviewState,
  request: {
    readonly urls: ReadonlyArray<string>;
    readonly placement: PreviewTabPlacement;
    readonly reuse: PreviewTabReuse;
    readonly sourceTabId?: string | undefined;
  },
): string | null {
  const targets = request.urls.flatMap((url) => parseUrl(url) ?? []);
  let best: PreviewSessionSnapshot | null = null;
  for (const tab of Object.values(state.sessions)) {
    if (tab.tabId === request.sourceTabId) continue;
    if (tab.automationOwner !== undefined || tab.reveal === false) continue;
    if (state.suppressedTabIds.has(tab.tabId)) continue;
    // A desktop-rendered tab reports navigation to the server after the fact.
    const navStatus = state.desktopByTabId[tab.tabId]?.navStatus ?? tab.navStatus;
    // Only a page that finished loading; a failed one may have recovered since.
    if (navStatus._tag !== "Success") continue;
    if (!samePlacement(tab, request.placement)) continue;
    const tabUrl = parseUrl(navStatus.url);
    if (!tabUrl || !targets.some((target) => addressMatches(tabUrl, target, request.reuse))) {
      continue;
    }
    if (tab.tabId === state.activeTabId) return tab.tabId;
    if (best === null || tab.updatedAt > best.updatedAt) best = tab;
  }
  return best?.tabId ?? null;
}

/** Shows an existing tab in the panel without navigating it or taking control of it. */
function revealPreviewTab(threadRef: ScopedThreadRef, tabId: string): void {
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const floating = miniPlayer.byThreadKey[scopedThreadKey(threadRef)]?.source;
  if (floating?.kind === "browser" && floating.tabId === tabId) miniPlayer.close(threadRef);
  useRightPanelStore.getState().openBrowser(threadRef, tabId);
  setActivePreviewTab(threadRef, tabId);
}

/**
 * Reveals a matching open tab for a foreground open and returns its id, or returns null so
 * the caller opens a new tab. Background opens (Cmd-click, middle click) always get a new tab.
 * A panel choice the reader made while the open was pending is kept.
 */
export function reuseOpenPreviewTab(input: {
  readonly threadRef: ScopedThreadRef;
  readonly authoredUrl: string;
  readonly target: { readonly url: string } & Omit<PreviewTabPlacement, "profileId">;
  readonly profileId: string | undefined;
  readonly sourceTabId?: string | undefined;
  readonly background: boolean | undefined;
  /** Preparation restarted a managed preview; an open tab shows its previous run. */
  readonly restarted: boolean | undefined;
  readonly reuse: PreviewTabReuse | undefined;
  readonly panelRevision: number;
}): string | null {
  if (input.background || input.restarted || input.reuse === "none") return null;
  const state = readThreadPreviewState(input.threadRef);
  if (Object.keys(state.sessions).length === 0) return null;
  const placement = resolvePlacement(input.threadRef.environmentId, {
    profileId: input.profileId,
    runtime: input.target.runtime,
    desktopHostId: input.target.desktopHostId,
    browserHost: input.target.browserHost,
  });
  if (placement === null) return null;
  const tabId = findReusablePreviewTab(state, {
    urls: [input.target.url, input.authoredUrl],
    placement,
    reuse: input.reuse ?? "address",
    sourceTabId: input.sourceTabId,
  });
  if (tabId === null) return null;
  rememberPreviewUrl(input.threadRef, input.authoredUrl);
  if (
    useRightPanelStore.getState().getUserActionRevision(input.threadRef) === input.panelRevision
  ) {
    revealPreviewTab(input.threadRef, tabId);
  }
  return tabId;
}
