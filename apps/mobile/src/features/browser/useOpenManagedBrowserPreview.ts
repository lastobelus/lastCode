import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type PreviewHostingLeaseSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useEnvironmentServerConfig } from "../../state/entities";
import { environmentBootstrap, useEnvironmentScope } from "../../state/session";

function useSupportsPreviewAssetRecovery(threadRef: ScopedThreadRef | null) {
  const config = useEnvironmentServerConfig(threadRef?.environmentId ?? null);
  const bootstrap = useAtomQueryRunner(environmentBootstrap, {
    reportFailure: false,
    refresh: true,
  });
  return async () => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
    if (config !== null) return config.environment.capabilities.previewAssetRecovery === true;
    const result = await bootstrap({ environmentId: threadRef.environmentId, input: undefined });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.config.environment.capabilities.previewAssetRecovery === true;
  };
}

export function useRenewPreviewDocumentUrl(threadRef: ScopedThreadRef | null) {
  const supportsAssetRecovery = useSupportsPreviewAssetRecovery(threadRef);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (url: string, refresh: boolean): Promise<string | null> => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
    if (!(await supportsAssetRecovery())) return null;
    const result = await createUrl({
      environmentId: threadRef.environmentId,
      input: { resource: { _tag: "preview-document", threadId: threadRef.threadId, url, refresh } },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.relativeUrl;
  };
}

export function useCreateManagedPreviewResourceUrl(threadRef: ScopedThreadRef | null) {
  const supportsAssetRecovery = useSupportsPreviewAssetRecovery(threadRef);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (lease: PreviewHostingLeaseSummary, url: string): Promise<string | null> => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
    if (!(await supportsAssetRecovery())) return null;
    const result = await createUrl({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "managed-preview-resource",
          threadId: threadRef.threadId,
          leaseId: lease.leaseId,
          url,
        },
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.relativeUrl;
  };
}

export function useOpenManagedBrowserPreview(threadRef: ScopedThreadRef | null) {
  const navigation = useNavigation();
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canOperate = useEnvironmentScope(threadRef?.environmentId ?? null, AuthPreviewOperateScope);
  if (!canOperate) return undefined;
  return async (url: string): Promise<void> => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
    const result = await open({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        url,
        runtime: "server",
        browserHost: "environment",
        profileId: "default",
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    navigation.navigate("ThreadBrowserPreview", {
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      tabId: result.value.tabId,
    });
  };
}
