import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  mayBeHostedPreviewUrl,
  prepareHostedPreview,
} from "~/components/preview/previewHostingRecovery";

import { recordVisitForThread } from "~/browserHistoryStore";
import { readLocalApi } from "~/localApi";
import { capturePreviewOpenFocus } from "~/previewStateStore";
import { readEnvironmentSupportsServerBrowser } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  canOpenLinksInApp,
  isWebUrl,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";
import { BrowserSettingsReadError, openPreparedUrlInPreview } from "./openFileInPreview";
import { openPreparedExternalUrl } from "./openPreparedExternalUrl";

const NO_MODIFIER = { metaKey: false, ctrlKey: false } as const;

/** Rejects on settings read failure without opening a browser, or if the system-browser fallback fails. */
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
    const event = options.event ?? NO_MODIFIER;
    const background = event.metaKey || event.ctrlKey || options.event?.button === 1;
    const potentialHostedLink =
      targetThreadRef != null && mayBeHostedPreviewUrl(targetThreadRef, url);
    const focus =
      targetThreadRef && potentialHostedLink
        ? capturePreviewOpenFocus(targetThreadRef, background)
        : undefined;
    if (!window.desktopBridge) {
      await openPreparedExternalUrl(
        url,
        async () => {
          await resolveBrowserLinkTargetPreference();
          if (!targetThreadRef) return url;
          const prepared = await prepareHostedPreview(targetThreadRef, url);
          if (
            prepared.managed &&
            isWebUrl(url) &&
            readEnvironmentScope(targetThreadRef.environmentId, AuthPreviewOperateScope) &&
            readEnvironmentSupportsServerBrowser(targetThreadRef.environmentId)
          ) {
            const result = await openPreparedUrlInPreview(
              {
                threadRef: targetThreadRef,
                url,
                openPreview,
                background,
              },
              prepared,
              focus,
            );
            if (isAtomCommandInterrupted(result)) return null;
            if (result._tag === "Success") {
              recordVisitForThread(targetThreadRef, url);
              return null;
            }
            throw squashAtomCommandFailure(result);
          }
          return hostedPreviewNavigationUrl(prepared);
        },
        {
          allowWithoutPopup: potentialHostedLink,
        },
      );
      return;
    }
    const preference = await resolveBrowserLinkTargetPreference();
    const prepared = targetThreadRef
      ? await prepareHostedPreview(targetThreadRef, url)
      : { url, managed: false, restored: false };
    const managedRemote =
      targetThreadRef != null &&
      prepared.managed &&
      isWebUrl(url) &&
      readEnvironmentScope(targetThreadRef.environmentId, AuthPreviewOperateScope) &&
      readEnvironmentSupportsServerBrowser(targetThreadRef.environmentId) &&
      !isLoopbackHost(new URL(prepared.url).hostname);
    const target = resolveLinkTarget({
      url,
      event,
      preference,
      canOpenInApp:
        targetThreadRef != null &&
        readEnvironmentScope(targetThreadRef.environmentId, AuthPreviewOperateScope) &&
        canOpenLinksInApp(targetThreadRef),
    });
    if ((managedRemote || target === "app") && targetThreadRef) {
      const result = await openPreparedUrlInPreview(
        {
          threadRef: targetThreadRef,
          url,
          openPreview,
          background: managedRemote && background,
        },
        prepared,
        focus,
      );
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        recordVisitForThread(targetThreadRef, url);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (managedRemote || failure instanceof BrowserSettingsReadError) throw failure;
      console.error(result.cause);
    }
    const api = readLocalApi();
    if (!api) throw new Error("Link opening is unavailable.");
    await api.shell.openExternal(hostedPreviewNavigationUrl(prepared));
  };
}
