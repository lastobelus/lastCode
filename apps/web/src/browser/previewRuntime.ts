import { useAtomValue } from "@effect/atom-react";
import {
  allowsPreviewTunnel,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentHasLocalDesktopBrowser,
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";

import { tunnelsEnvironmentLoopback } from "./browserTargetResolver";

/** Whether this desktop loads the environment's localhost itself: it is local, or its tunnel is on. */
const desktopLoadsLoopbackAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const target = get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target;
    if (!tunnelsEnvironmentLoopback(target)) return true;
    const config = get(environmentServerConfigsAtom).get(environmentId);
    return config !== undefined && allowsPreviewTunnel(config);
  }).pipe(Atom.withLabel(`preview:desktop-loads-loopback:${environmentId}`)),
);

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

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  // Without its tunnel, another environment's tabs stream from it, as on the web.
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom) &&
    appAtomRegistry.get(desktopLoadsLoopbackAtom(environmentId))
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  desktopLoadsLoopback: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  if (snapshot.runtime === "server") return desktopLoadsLoopback ? "desktop" : null;
  return "server";
}

export function useDesktopLoadsLoopback(environmentId: EnvironmentId): boolean {
  return useAtomValue(desktopLoadsLoopbackAtom(environmentId));
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

/** Native pages belong to the desktop that owns their backing page; other pages stream. */
export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot:
    | Pick<PreviewSessionSnapshot, "runtime" | "headless" | "desktopHostId" | "backingPage">
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
    !snapshot.headless &&
    (snapshot.backingPage === "desktop" || legacyOwnedTab) &&
    (snapshot.desktopHostId === "local"
      ? primaryEnvironmentId !== null && environmentId === primaryEnvironmentId
      : snapshot.desktopHostId === getDesktopBrowserHostId(environmentId))
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot:
    | Pick<PreviewSessionSnapshot, "runtime" | "headless" | "desktopHostId" | "backingPage">
    | null
    | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
