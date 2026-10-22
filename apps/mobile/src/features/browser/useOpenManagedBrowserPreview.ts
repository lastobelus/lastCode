import { useNavigation } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PreviewHostingLeaseSummary, ScopedThreadRef } from "@t3tools/contracts";

import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

export function useRenewPreviewDocumentUrl(threadRef: ScopedThreadRef | null) {
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (url: string, refresh: boolean): Promise<string> => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
    const result = await createUrl({
      environmentId: threadRef.environmentId,
      input: { resource: { _tag: "preview-document", threadId: threadRef.threadId, url, refresh } },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.relativeUrl;
  };
}

export function useCreateManagedPreviewResourceUrl(threadRef: ScopedThreadRef | null) {
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return async (lease: PreviewHostingLeaseSummary, url: string): Promise<string> => {
    if (threadRef === null) throw new Error("The preview has no owning thread.");
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
