import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import { isBuiltInBrowserProfileId } from "@t3tools/contracts";
import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import type {
  EnvironmentId,
  PreviewAppearancePreference,
  PreviewOpenInput,
  PreviewRuntime,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
  PreviewZoomFactor,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserSettingsReadError, isBrowserSettingsReadError } from "~/browser/openFileInPreview";
import { desktopBrowserHostFor, previewRuntimeFor } from "~/browser/previewRuntime";
import {
  preparedPreviewOpenProfileId,
  preparedPreviewOpenTarget,
} from "~/browser/preparedPreviewOpenTarget";
import { applyPreviewServerSnapshot, rememberPreviewUrl } from "~/previewStateStore";
import { prepareHostedPreview } from "./previewHostingRecovery";

interface OpenPreviewSessionInput<E> {
  openPreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewOpenInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;
  threadRef: ScopedThreadRef;
  url?: string;
  viewport?: PreviewViewportSetting;
  profileId?: string;
  zoomFactor?: PreviewZoomFactor;
  colorScheme?: PreviewAppearancePreference;
  runtime?: PreviewRuntime;
  sourcePlacement?: Pick<PreviewSessionSnapshot, "runtime" | "desktopHostId" | "backingPage">;
}

export async function openPreviewSession<E>(
  input: OpenPreviewSessionInput<E>,
): Promise<AtomCommandResult<PreviewSessionSnapshot, E | BrowserSettingsReadError>> {
  // Wait for settings hydration so new tabs cannot retain uncorrected schema defaults.
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (isBrowserSettingsReadError(defaults)) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const preparedUrl =
    input.url === undefined ? undefined : await prepareHostedPreview(input.threadRef, input.url);
  const { sourcePlacement } = input;
  const profileId =
    sourcePlacement !== undefined || preparedUrl === undefined || input.runtime === "desktop"
      ? (input.profileId ?? defaults.profileId)
      : preparedPreviewOpenProfileId(preparedUrl, defaults.profileId, input.profileId);
  const runtime = input.runtime ?? previewRuntimeFor(input.threadRef.environmentId);
  const useSourceEnvironmentBrowser =
    sourcePlacement?.backingPage === "server" && isBuiltInBrowserProfileId(profileId);
  const desktopHostId =
    runtime === "server" && input.runtime === undefined
      ? desktopBrowserHostFor(input.threadRef.environmentId)
      : undefined;
  // A duplicate keeps the source's browser placement. An explicit runtime move below chooses
  // a new host and can intentionally leave the desktop's profile behind.
  const sourceTarget =
    sourcePlacement === undefined
      ? undefined
      : {
          ...(preparedUrl === undefined
            ? {}
            : {
                url: hostedPreviewNavigationUrl(
                  preparedUrl,
                  useSourceEnvironmentBrowser
                    ? (preparedUrl.localUrl ?? input.url ?? preparedUrl.url)
                    : preparedUrl.url,
                ),
              }),
          ...(sourcePlacement.runtime === "server"
            ? {
                runtime: "server" as const,
                ...(useSourceEnvironmentBrowser ? { browserHost: "environment" as const } : {}),
                ...(sourcePlacement.desktopHostId === undefined
                  ? {}
                  : { desktopHostId: sourcePlacement.desktopHostId }),
              }
            : {}),
        };
  const target =
    sourceTarget ??
    (preparedUrl === undefined
      ? {
          ...(runtime === undefined || runtime === "desktop" ? {} : { runtime }),
          ...(desktopHostId === undefined ? {} : { desktopHostId }),
          ...(input.runtime === "server" ? { browserHost: "environment" as const } : {}),
        }
      : preparedPreviewOpenTarget(
          input.threadRef.environmentId,
          preparedUrl,
          input.url ?? preparedUrl.url,
          profileId,
          input.runtime,
        ));
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      ...target,
      viewport: input.viewport ?? defaults.viewport,
      profileId,
      ...(target.runtime === undefined
        ? {}
        : {
            zoomFactor: input.zoomFactor ?? defaults.zoomFactor,
            colorScheme: input.colorScheme ?? defaults.appearance,
          }),
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
