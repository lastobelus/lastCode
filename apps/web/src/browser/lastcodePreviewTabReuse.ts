import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_BROWSER_PROFILE_ID,
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

/**
 * Which open tab a foreground link may reveal instead of opening another.
 * `address`: the same address, or on a local host the same origin and path.
 * `origin`: any page on the same origin, for an entry point such as a hub index.
 */
export type PreviewTabReuse = "address" | "origin";

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
  return isLocalHost(target.hostname) && tab.pathname === target.pathname;
}

function samePlacement(tab: PreviewSessionSnapshot, target: PreviewTabPlacement): boolean {
  if (
    (tab.profileId ?? DEFAULT_BROWSER_PROFILE_ID) !==
    (target.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
  ) {
    return false;
  }
  if (target.runtime !== "server" && target.browserHost !== "environment") {
    return tab.runtime !== "server";
  }
  if (tab.runtime !== "server") return false;
  if (target.browserHost === "environment") return tab.desktopHostId === undefined;
  if (target.desktopHostId !== undefined) return tab.desktopHostId === target.desktopHostId;
  // The server chooses its own desktop browser, or none, for an open that names no host.
  return tab.desktopHostId === undefined || tab.desktopHostId === "local";
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
  },
): string | null {
  const targets = request.urls.flatMap((url) => parseUrl(url) ?? []);
  let best: PreviewSessionSnapshot | null = null;
  for (const tab of Object.values(state.sessions)) {
    if (tab.automationOwner !== undefined || tab.reveal === false) continue;
    if (state.suppressedTabIds.has(tab.tabId)) continue;
    if (tab.navStatus._tag === "Idle") continue;
    if (!samePlacement(tab, request.placement)) continue;
    const tabUrl = parseUrl(tab.navStatus.url);
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
  readonly background: boolean | undefined;
  readonly reuse: PreviewTabReuse | undefined;
  readonly panelRevision: number;
}): string | null {
  if (input.background) return null;
  const tabId = findReusablePreviewTab(readThreadPreviewState(input.threadRef), {
    urls: [input.target.url, input.authoredUrl],
    placement: {
      profileId: input.profileId,
      runtime: input.target.runtime,
      desktopHostId: input.target.desktopHostId,
      browserHost: input.target.browserHost,
    },
    reuse: input.reuse ?? "address",
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
