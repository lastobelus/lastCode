import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentHasLocalDesktopBrowser,
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

import { getDesktopBrowserHostId } from "./desktopBrowserTransport";

/** Pin native profile opens to this desktop's host for the environment. */
export function desktopBrowserHostFor(environmentId: EnvironmentId): string | undefined {
  if (!isElectron) return undefined;
  if (appAtomRegistry.get(primaryEnvironmentIdAtom) !== environmentId)
    return getDesktopBrowserHostId(environmentId);
  const localDesktopBrowser = readEnvironmentHasLocalDesktopBrowser(environmentId);
  return localDesktopBrowser === true
    ? "local"
    : localDesktopBrowser === false
      ? getDesktopBrowserHostId(environmentId)
      : undefined;
}

/**
 * Where a tab the user opens should run. The desktop app draws its own
 * server's tabs natively, so those stay agent-drivable at no cost. A remote
 * environment's tabs would stream, so the desktop opens them in its own
 * browser instead: no latency, and it reaches what this computer reaches. The
 * user can move a tab to the environment when only it can reach the page.
 */
export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

/**
 * The other browser a tab can move to, or null when it has none: a desktop
 * tab of a remote environment can move to that environment's browser, and back.
 */
export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

/** Electron hosts its own browser tabs; other clients need the environment to host them. */
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

/**
 * Whether this desktop owns the server tab's native backing page and should
 * draw it with its own `<webview>`. Headless pages, existing native popups,
 * and pages owned by another desktop are streamed instead.
 */
export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot:
    | Pick<PreviewSessionSnapshot, "runtime" | "desktopHostId" | "backingPage">
    | null
    | undefined,
): boolean {
  // Older remote servers already pin native tabs to this desktop but do not
  // report a backing page. Preserve only that explicit owner-matched route.
  const legacyOwnedTab =
    snapshot?.backingPage === undefined &&
    snapshot?.desktopHostId !== undefined &&
    snapshot.desktopHostId !== "local" &&
    snapshot.desktopHostId === getDesktopBrowserHostId(environmentId);
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    (snapshot.backingPage === "desktop" || legacyOwnedTab) &&
    (snapshot.desktopHostId === "local"
      ? primaryEnvironmentId !== null && environmentId === primaryEnvironmentId
      : snapshot.desktopHostId === getDesktopBrowserHostId(environmentId))
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot:
    | Pick<PreviewSessionSnapshot, "runtime" | "desktopHostId" | "backingPage">
    | null
    | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
