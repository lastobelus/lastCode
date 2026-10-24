import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { prepareHostedPreview } from "~/components/preview/previewHostingRecovery";

import { recordVisitForThread } from "~/browserHistoryStore";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  canOpenLinksInApp,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";
import { BrowserSettingsReadError, openUrlInPreview } from "./openFileInPreview";
import { openPreparedExternalUrl } from "./openPreparedExternalUrl";

const NO_MODIFIER = { metaKey: false, ctrlKey: false } as const;

/**
 * Failed settings reads reject without opening a browser. The promise also
 * rejects if the system-browser fallback fails.
 */
export function useOpenLink(threadRef: ScopedThreadRef | null | undefined): (
  url: string,
  options?: {
    readonly event?: {
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly button?: number | undefined;
    };
    readonly threadRef?: ScopedThreadRef | undefined;
  },
) => Promise<void> {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return async (url, options = {}) => {
    const targetThreadRef = options.threadRef ?? threadRef;
    if (!window.desktopBridge) {
      await openPreparedExternalUrl(url, async () => {
        await resolveBrowserLinkTargetPreference();
        return targetThreadRef
          ? hostedPreviewNavigationUrl(await prepareHostedPreview(targetThreadRef, url))
          : url;
      });
      return;
    }
    const target = resolveLinkTarget({
      url,
      event: options.event ?? NO_MODIFIER,
      preference: await resolveBrowserLinkTargetPreference(),
      canOpenInApp:
        targetThreadRef != null &&
        readEnvironmentScope(targetThreadRef.environmentId, AuthPreviewOperateScope) &&
        canOpenLinksInApp(targetThreadRef),
    });
    if (target === "app" && targetThreadRef) {
      const result = await openUrlInPreview({ threadRef: targetThreadRef, url, openPreview });
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        recordVisitForThread(targetThreadRef, url);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (failure instanceof BrowserSettingsReadError) throw failure;
      console.error(result.cause);
    }
    const api = readLocalApi();
    if (!api) throw new Error("Link opening is unavailable.");
    const prepared = targetThreadRef ? await prepareHostedPreview(targetThreadRef, url) : { url };
    await api.shell.openExternal(hostedPreviewNavigationUrl(prepared));
  };
}
