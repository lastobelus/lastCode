import { appAtomRegistry } from "~/rpc/atomRegistry";
import { getDesktopBrowserHostId } from "./desktopBrowserTransport";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  readEnvironmentHasLocalDesktopBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

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

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  return readEnvironmentSupportsServerBrowser(environmentId) ? "server" : undefined;
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
 * Whether this client draws a server tab with its own `<webview>`. The desktop
 * app renders tabs of the server it launched, which drives them over the
 * desktop browser channel; every other client and environment streams them.
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
