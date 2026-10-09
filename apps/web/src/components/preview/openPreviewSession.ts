import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import type {
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "~/browser/browserDefaults";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { desktopBrowserHostFor, previewRuntimeFor } from "~/browser/previewRuntime";
import { applyPreviewServerSnapshot, rememberPreviewUrl } from "~/previewStateStore";
import { prepareHostedPreview } from "./previewHostingRecovery";

interface OpenPreviewSessionInput<E> {
  openPreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
  threadRef: ScopedThreadRef;
  url?: string;
  /** Overrides the configured default; automation passes an explicit size. */
  viewport?: PreviewViewportSetting;
  /** Overrides the configured default profile. */
  profileId?: string;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E | BrowserSettingsReadError>> {
  // Resolved once: a tab opened before client settings hydrate would otherwise
  // be born at the schema defaults and never corrected.
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const desktopHostId =
    runtime === "server" ? desktopBrowserHostFor(input.threadRef.environmentId) : undefined;
  const preparedUrl =
    input.url === undefined ? undefined : await prepareHostedPreview(input.threadRef, input.url);
  const url =
    preparedUrl === undefined
      ? undefined
      : hostedPreviewNavigationUrl(
          preparedUrl,
          runtime === "server" && desktopHostId === undefined ? input.url : preparedUrl.url,
        );
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...(url === undefined ? {} : { url }),
      viewport: input.viewport ?? browserDefaultOpenViewport(defaults),
      profileId: input.profileId ?? browserDefaultOpenProfileId(defaults),
      ...(runtime === undefined ? {} : { runtime }),
      ...(desktopHostId === undefined ? {} : { desktopHostId }),
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const snapshot = result.value;
  applyPreviewServerSnapshot(input.threadRef, snapshot);
  if (input.url !== undefined) {
    rememberPreviewUrl(
      input.threadRef,
      snapshot.navStatus._tag === "Idle"
        ? input.url
        : stripPreviewBootstrapTokenFromUrl(new URL(snapshot.navStatus.url)).href,
    );
  }
  return result;
}
