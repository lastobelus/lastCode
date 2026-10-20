import {
  isBuiltInBrowserProfileId,
  type EnvironmentId,
  type PreviewRuntime,
} from "@t3tools/contracts";
import {
  hostedPreviewNavigationUrl,
  type PreparedHostedPreview,
} from "@t3tools/client-runtime/preview-hosting";

import { readEnvironmentSupportsServerBrowser } from "~/state/entities";
import { desktopBrowserHostFor, previewRuntimeFor } from "./previewRuntime";

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
