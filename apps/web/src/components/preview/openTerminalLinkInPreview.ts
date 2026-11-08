import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import { resolveBrowserDefaults, resolveBrowserOpenProfileId } from "~/browser/browserDefaults";
import { isWebUrl, resolveBrowserLinkTargetPreference } from "~/browser/browserLinkTarget";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import {
  preparedPreviewOpenProfileId,
  preparedPreviewOpenTarget,
} from "~/browser/preparedPreviewOpenTarget";
import { openPreparedExternalUrl } from "~/browser/openPreparedExternalUrl";
import { recordVisitForThread } from "~/browserHistoryStore";
import {
  applyPreviewServerSnapshot,
  capturePreviewOpenFocus,
  hiddenPreviewTabIds,
  readThreadPreviewState,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { mayBeHostedPreviewUrl, prepareHostedPreview } from "./previewHostingRecovery";

const terminalLinkErrorContext = {
  environmentId: Schema.String,
  threadId: Schema.String,
  targetOrigin: Schema.String,
  cause: Schema.Defect(),
};

export class TerminalLinkPreviewOpenError extends Schema.TaggedError<TerminalLinkPreviewOpenError>()(
  "TerminalLinkPreviewOpenError",
  terminalLinkErrorContext,
) {
  override get message(): string {
    return `Failed to open terminal link ${this.targetOrigin} in preview for thread ${this.threadId}.`;
  }
}

export class TerminalLinkProfileUnavailableError extends Schema.TaggedError<TerminalLinkProfileUnavailableError>()(
  "TerminalLinkProfileUnavailableError",
  { reason: Schema.Literals(["hosted-web", "preview-unavailable"]) },
) {
  override get message(): string {
    return this.reason === "hosted-web"
      ? "Open this Action link in the desktop app that owns the configured browser profile."
      : "Opening this Action link requires the integrated Browser with its named profile.";
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly terminalLinkProfileName?: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: (url: string) => void;
  /** Cmd/Ctrl-click opens externally after any named desktop profile is validated. */
  readonly forceBrowser: boolean;
}

export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
  const webClient = typeof window !== "undefined" && !window.desktopBridge;
  // A web client cannot validate or reuse the owning desktop's cookie jar,
  // including when a modifier requests an external browser.
  if (webClient && input.terminalLinkProfileName !== undefined) {
    throw new TerminalLinkProfileUnavailableError({ reason: "hosted-web" });
  }
  const focus = capturePreviewOpenFocus(input.threadRef, input.forceBrowser);
  const handledOpenTabIds = readThreadPreviewState(input.threadRef).handledOpenTabIds;
  // Resolve explicit intent before either browser opens. Never infer it from the URL.
  const explicitDefaults =
    input.terminalLinkProfileName === undefined ? undefined : await resolveBrowserDefaults();
  const explicitProfileId =
    explicitDefaults === undefined
      ? undefined
      : resolveBrowserOpenProfileId(
          { profileName: input.terminalLinkProfileName },
          explicitDefaults,
        );
  const potentialIntegratedLink =
    webClient && !input.forceBrowser && mayBeHostedPreviewUrl(input.threadRef, input.url);
  const prepareDestination = async () => {
    const prepared = await prepareHostedPreview(input.threadRef, input.url);
    if (webClient && !potentialIntegratedLink) return hostedPreviewNavigationUrl(prepared);
    const supportsPreview =
      !input.forceBrowser &&
      isWebUrl(input.url) &&
      isPreviewAvailableFor(input.threadRef.environmentId) &&
      input.threadRef.threadId.length > 0 &&
      (await resolveBrowserLinkTargetPreference()) === "app";

    if (!supportsPreview) {
      if (explicitProfileId !== undefined && !input.forceBrowser) {
        throw new TerminalLinkProfileUnavailableError({ reason: "preview-unavailable" });
      }
      return hostedPreviewNavigationUrl(prepared);
    }

    const errorContext = {
      environmentId: input.threadRef.environmentId,
      threadId: input.threadRef.threadId,
      targetOrigin: new URL(input.url).origin,
    };

    const defaults = explicitDefaults ?? (await resolveBrowserDefaults());
    const profileId = preparedPreviewOpenProfileId(prepared, defaults.profileId, explicitProfileId);
    const result = await input.openPreview({
      environmentId: input.threadRef.environmentId,
      input: {
        threadId: input.threadRef.threadId,
        ...preparedPreviewOpenTarget(input.threadRef.environmentId, prepared, input.url, profileId),
        viewport: defaults.viewport,
        profileId,
        focus,
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        return null;
      }
      const error = new TerminalLinkPreviewOpenError({ ...errorContext, cause: result.cause });
      if (explicitProfileId !== undefined) throw error;
      console.error(error);
      return hostedPreviewNavigationUrl(prepared);
    }
    recordVisitForThread(input.threadRef, input.url);
    const creationFocusHandled =
      !handledOpenTabIds.has(result.value.tabId) &&
      readThreadPreviewState(input.threadRef).handledOpenTabIds.has(result.value.tabId);
    const panel = useRightPanelStore.getState();
    if (
      creationFocusHandled ||
      panel.getUserActionRevision(input.threadRef) !== focus.userActionRevision
    ) {
      updatePreviewServerSnapshot(input.threadRef, result.value, { consumeOpenFocus: true });
    } else {
      applyPreviewServerSnapshot(input.threadRef, result.value);
      const state = readThreadPreviewState(input.threadRef);
      panel.reconcileBrowserSurfaces(
        input.threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
        result.value.tabId,
      );
    }
    return null;
  };

  if (webClient) {
    await openPreparedExternalUrl(input.url, prepareDestination, {
      allowWithoutPopup: potentialIntegratedLink,
    });
    return;
  }
  const destination = await prepareDestination();
  if (destination !== null) input.fallbackToBrowser(destination);
}
