import {
  prepareHostedPreview as prepareOwnedPreview,
  HostedPreviewRecoveryError,
  isSavedDocumentCapability,
  type PreparedHostedPreview,
} from "@t3tools/client-runtime/preview-hosting";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  environmentBootstrap,
  readPreparedConnection,
  readConfiguredPreviewEnvironmentUrl,
} from "~/state/session";
import { previewEnvironment } from "~/state/preview";
import { assetEnvironment } from "~/state/assets";
import { serverEnvironment } from "~/state/server";

export { selectHostedPreview } from "@t3tools/client-runtime/preview-hosting";

/** Intercept potential owned links before the shell opens them without recovery. */
export function mayBeHostedPreviewUrl(threadRef: ScopedThreadRef, url: string): boolean {
  const connection = readPreparedConnection(threadRef.environmentId);
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (isSavedDocumentCapability(parsed) ||
        isPrivateNetworkHost(parsed.hostname) ||
        (connection !== null && parsed.hostname === new URL(connection.httpBaseUrl).hostname))
    );
  } catch {
    return false;
  }
}

export async function prepareHostedPreview(
  threadRef: ScopedThreadRef,
  url: string,
  purpose: "navigation" | "resource" = "navigation",
): Promise<PreparedHostedPreview> {
  let connection = readPreparedConnection(threadRef.environmentId);
  let config = appAtomRegistry.get(serverEnvironment.configValueAtom(threadRef.environmentId));
  let configuredEndpoint = readConfiguredPreviewEnvironmentUrl(threadRef.environmentId);
  if (connection === null || config === null) {
    const original = { url, managed: false, restored: false } as const;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return original;
    }
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      (!isSavedDocumentCapability(target) &&
        !isPrivateNetworkHost(target.hostname) &&
        ![connection?.httpBaseUrl, configuredEndpoint].some((endpoint) => {
          if (!endpoint) return false;
          try {
            return new URL(endpoint).hostname === target.hostname;
          } catch {
            return false;
          }
        }))
    ) {
      return original;
    }
    const result = await executeAtomQuery(
      appAtomRegistry,
      environmentBootstrap({ environmentId: threadRef.environmentId, input: undefined }),
      { reportFailure: false, refresh: true },
    );
    if (result._tag === "Failure")
      throw new HostedPreviewRecoveryError(squashAtomCommandFailure(result));
    connection = result.value.prepared;
    config = result.value.config;
    configuredEndpoint = readConfiguredPreviewEnvironmentUrl(threadRef.environmentId);
  }
  const supportsAssetRecovery = config.environment.capabilities.previewAssetRecovery === true;
  return prepareOwnedPreview({
    threadRef,
    url,
    purpose,
    environmentUrl: connection.httpBaseUrl,
    knownEnvironmentUrls: configuredEndpoint === null ? [] : [configuredEndpoint],
    renewDocumentUrl: supportsAssetRecovery
      ? async (url, refresh) => {
          const result = await executeAtomQuery(
            appAtomRegistry,
            assetEnvironment.createUrl({
              environmentId: threadRef.environmentId,
              input: {
                resource: { _tag: "preview-document", threadId: threadRef.threadId, url, refresh },
              },
            }),
            { reportFailure: false, refresh: true },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value.relativeUrl;
        }
      : undefined,
    list: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.hostingList,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error("Preview leases unavailable.");
      return result.value;
    },
    recover: async (lease, options) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.hostingRecover,
        {
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            leaseId: lease.leaseId,
            url: lease.url,
            bootstrap: options.bootstrap,
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    createResourceUrl: supportsAssetRecovery
      ? async (lease, localUrl) => {
          const result = await executeAtomQuery(
            appAtomRegistry,
            assetEnvironment.createUrl({
              environmentId: threadRef.environmentId,
              input: {
                resource: {
                  _tag: "managed-preview-resource",
                  threadId: threadRef.threadId,
                  leaseId: lease.leaseId,
                  url: localUrl,
                },
              },
            }),
            { reportFailure: false, refresh: true },
          );
          if (result._tag === "Failure") throw new Error("Preview resource unavailable.");
          return result.value.relativeUrl;
        }
      : undefined,
  });
}

/** Restore only this thread's native preview; never send an agent message. */
export async function recoverHostedPreview(
  threadRef: ScopedThreadRef,
  url: string,
): Promise<boolean> {
  return (await prepareHostedPreview(threadRef, url, "resource")).restored;
}
