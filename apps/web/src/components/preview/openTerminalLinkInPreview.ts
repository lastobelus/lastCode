import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
  resolveBrowserOpenProfileId,
} from "~/browser/browserDefaults";
import { isWebUrl, resolveBrowserLinkTargetPreference } from "~/browser/browserLinkTarget";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import {
  desktopBrowserHostFor,
  isPreviewAvailableFor,
  previewRuntimeFor,
} from "~/browser/previewRuntime";
import { openPreparedExternalUrl } from "~/browser/openPreparedExternalUrl";
import { recordVisitForThread } from "~/browserHistoryStore";
import { applyPreviewServerSnapshot } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { prepareHostedPreview } from "./previewHostingRecovery";

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
  {},
) {
  override get message(): string {
    return "Opening this Action link requires the integrated Browser with its named profile.";
  }
}

interface OpenTerminalLinkInPreviewInput<E> {
  readonly url: string;
  readonly terminalLinkProfileName?: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly fallbackToBrowser: (url: string) => void;
  /** Cmd/Ctrl-click bypasses the preference and opens in the system browser. */
  readonly forceBrowser: boolean;
}

/**
 * Opens a terminal hyperlink where the "Open links in" setting says, unless a
 * Cmd/Ctrl-click explicitly requests the system browser.
 */
export async function openTerminalLinkInPreview<E>(
  input: OpenTerminalLinkInPreviewInput<E>,
): Promise<void> {
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
  if (typeof window !== "undefined" && !window.desktopBridge) {
    if (explicitProfileId !== undefined && !input.forceBrowser) {
      throw new TerminalLinkProfileUnavailableError();
    }
    await openPreparedExternalUrl(input.url, async () =>
      hostedPreviewNavigationUrl(await prepareHostedPreview(input.threadRef, input.url)),
    );
    return;
  }
  const prepared = await prepareHostedPreview(input.threadRef, input.url);
  const supportsPreview =
    !input.forceBrowser &&
    isWebUrl(input.url) &&
    isPreviewAvailableFor(input.threadRef.environmentId) &&
    input.threadRef.threadId.length > 0 &&
    (await resolveBrowserLinkTargetPreference()) === "app";

  if (!supportsPreview) {
    if (explicitProfileId !== undefined && !input.forceBrowser) {
      throw new TerminalLinkProfileUnavailableError();
    }
    input.fallbackToBrowser(hostedPreviewNavigationUrl(prepared));
    return;
  }

  const errorContext = {
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    targetOrigin: new URL(input.url).origin,
  };

  const defaults = explicitDefaults ?? (await resolveBrowserDefaults());
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const desktopHostId =
    runtime === "server" ? desktopBrowserHostFor(input.threadRef.environmentId) : undefined;
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: hostedPreviewNavigationUrl(
        prepared,
        runtime === "server" && desktopHostId === undefined ? input.url : prepared.url,
      ),
      // Same reason as `openUrlInPreview`: this path handles its own result
      // mapping, so the configured defaults are applied explicitly.
      viewport: browserDefaultOpenViewport(defaults),
      profileId: explicitProfileId ?? browserDefaultOpenProfileId(defaults),
      ...(runtime === undefined ? {} : { runtime }),
      ...(desktopHostId === undefined ? {} : { desktopHostId }),
    },
  });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const error = new TerminalLinkPreviewOpenError({ ...errorContext, cause: result.cause });
    if (explicitProfileId !== undefined) throw error;
    console.error(error);
    input.fallbackToBrowser(hostedPreviewNavigationUrl(prepared));
    return;
  }
  recordVisitForThread(input.threadRef, input.url);
  applyPreviewServerSnapshot(input.threadRef, result.value);
  useRightPanelStore.getState().openBrowser(input.threadRef, result.value.tabId);
}
