import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  fileAssetResourceForAccess,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const canReadResource =
    fileAccess.canReadFiles ||
    (fileAccess.canReadThreadFiles &&
      (resource?._tag === "workspace-file" || resource?._tag === "media-file")) ||
    (resource?._tag !== "workspace-file" &&
      resource?._tag !== "media-file" &&
      resource?._tag !== "draft-workspace-file");
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    !canReadResource || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({
          environmentId,
          input: { resource: fileAssetResourceForAccess(resource, fileAccess.canReadFiles) },
        }),
  );
  if (!canReadResource) return { _tag: fileAccess.isPending ? "Loading" : "Failure" };
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({
      environmentId,
      input: {
        resource: fileAccess.canReadThreadFiles
          ? fileAssetResourceForAccess(resource, fileAccess.canReadFiles)
          : resource,
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  }, [
    environmentId,
    resource,
    refresh,
    httpBaseUrl,
    fileAccess.canReadFiles,
    fileAccess.canReadThreadFiles,
  ]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles, canReadThreadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = useMemo(
    () =>
      resources
        .filter(
          (resource) =>
            canReadFiles ||
            (canReadThreadFiles &&
              (resource._tag === "workspace-file" || resource._tag === "media-file")) ||
            (resource._tag !== "workspace-file" &&
              resource._tag !== "media-file" &&
              resource._tag !== "draft-workspace-file"),
        )
        .map((resource) => fileAssetResourceForAccess(resource, canReadFiles)),
    [canReadFiles, canReadThreadFiles, resources],
  );
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  return useMemo(() => {
    if (preparedConnection._tag === "None") return resources.map(() => null);
    let resultIndex = 0;
    return resources.map((resource) => {
      if (
        !canReadFiles &&
        ((!canReadThreadFiles &&
          (resource._tag === "workspace-file" || resource._tag === "media-file")) ||
          resource._tag === "draft-workspace-file")
      )
        return null;
      const result = results[resultIndex++];
      return result && AsyncResult.isSuccess(result)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null;
    });
  }, [canReadFiles, canReadThreadFiles, preparedConnection, resources, results]);
}
