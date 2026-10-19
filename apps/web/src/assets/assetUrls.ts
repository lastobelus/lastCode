import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState as RuntimeAssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
  fileAssetResourceForAccess,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState = RuntimeAssetUrlState & { readonly waiting?: boolean };

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const scopedResource =
    resource === null ? null : fileAssetResourceForAccess(resource, fileAccess.canReadFiles);
  const blocked = blockedAssetUrlState(scopedResource, fileAccess);
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null || scopedResource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({
          environmentId,
          input: { resource: scopedResource },
        }),
  );
  if (blocked !== null) return blocked;
  return {
    ...assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    ),
    ...(result.waiting ? { waiting: true } : {}),
  };
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
  return async () => {
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
  };
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const { canReadFiles, canReadThreadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = resources
    .filter(
      (resource) =>
        canReadFiles ||
        (canReadThreadFiles &&
          (resource._tag === "workspace-file" || resource._tag === "media-file")) ||
        !isFileResource(resource),
    )
    .map((resource) => fileAssetResourceForAccess(resource, canReadFiles));
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  if (preparedConnection._tag === "None") return resources.map(() => null);
  const urls: Array<string | null> = [];
  let resultIndex = 0;
  for (const resource of resources) {
    if (
      !canReadFiles &&
      ((!canReadThreadFiles && isFileResource(resource)) ||
        resource._tag === "draft-workspace-file")
    ) {
      urls.push(null);
      continue;
    }
    const result = results[resultIndex];
    resultIndex += 1;
    urls.push(
      result && AsyncResult.isSuccess(result)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null,
    );
  }
  return urls;
}

function isFileResource(resource: AssetResource): boolean {
  return (
    resource._tag === "workspace-file" ||
    resource._tag === "media-file" ||
    resource._tag === "draft-workspace-file"
  );
}
