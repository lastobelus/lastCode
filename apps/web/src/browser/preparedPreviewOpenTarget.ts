import {
  isBuiltInBrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
  type PreviewRuntime,
} from "@t3tools/contracts";
import {
  hostedPreviewNavigationUrl,
  type PreparedHostedPreview,
} from "@t3tools/client-runtime/preview-hosting";

import { readEnvironmentSupportsServerBrowser } from "~/state/entities";
import { desktopBrowserHostFor, previewRuntimeFor } from "./previewRuntime";

export function preparedPreviewOpenProfileId(
  prepared: PreparedHostedPreview,
  defaultProfileId: string,
  explicitProfileId?: string,
) {
  return (
    explicitProfileId ??
    (prepared.managed && prepared.localUrl !== undefined
      ? DEFAULT_BROWSER_PROFILE_ID
      : defaultProfileId)
  );
}

/** A managed app's loopback listener is reachable from its environment's browser. */
export function preparedPreviewOpenTarget(
  environmentId: EnvironmentId,
  prepared: PreparedHostedPreview,
  authoredUrl: string,
  profileId: string | undefined,
  requestedRuntime?: PreviewRuntime,
) {
  if (
    requestedRuntime === "server" ||
    (requestedRuntime !== "desktop" &&
      prepared.managed &&
      prepared.localUrl !== undefined &&
      (profileId === undefined || isBuiltInBrowserProfileId(profileId)) &&
      readEnvironmentSupportsServerBrowser(environmentId))
  ) {
    return {
      url: hostedPreviewNavigationUrl(prepared, prepared.localUrl ?? authoredUrl),
      runtime: "server" as const,
      browserHost: "environment" as const,
    };
  }
  const runtime = requestedRuntime === "desktop" ? undefined : previewRuntimeFor(environmentId);
  const desktopHostId = runtime === "server" ? desktopBrowserHostFor(environmentId) : undefined;
  return {
    url: hostedPreviewNavigationUrl(
      prepared,
      runtime === "server" && desktopHostId === undefined ? authoredUrl : prepared.url,
    ),
    ...(runtime === undefined ? {} : { runtime }),
    ...(desktopHostId === undefined ? {} : { desktopHostId }),
  };
}
