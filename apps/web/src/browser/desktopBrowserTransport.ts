import { isLoopbackHost } from "@t3tools/shared/preview";
import { resolveBrowserNavigationTarget } from "./browserTargetResolver";
import type { EnvironmentId } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";

const hostIds = new Map<EnvironmentId, string>();

/** A desktop window owns one channel per environment, including after renderer reloads. */
export function getDesktopBrowserHostId(environmentId: EnvironmentId): string {
  let id = hostIds.get(environmentId);
  if (!id) {
    // Session storage survives renderer reload/crash without sharing ownership across windows.
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const storageKey = `t3:desktop-browser-host:${environmentId}`;
    id = storage?.getItem(storageKey) || randomUUID();
    storage?.setItem(storageKey, id);
    hostIds.set(environmentId, id);
  }
  return id;
}

/** Resolve environment loopback URLs before a remote native tab navigates. */
export function resolveDesktopBrowserUrl(
  environmentId: EnvironmentId,
  rawUrl: string,
): string | null {
  try {
    const url = new URL(rawUrl);
    if (!isLoopbackHost(url.hostname)) return rawUrl;
    const resolved = resolveBrowserNavigationTarget(environmentId, {
      kind: "environment-port",
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      protocol: url.protocol === "https:" ? "https" : "http",
      path: `${url.pathname}${url.search}${url.hash}`,
    }).resolvedUrl;
    const destination = new URL(resolved);
    url.hostname = destination.hostname;
    url.port = destination.port;
    return url.toString();
  } catch {
    return null;
  }
}
