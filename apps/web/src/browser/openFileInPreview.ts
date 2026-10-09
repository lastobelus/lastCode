import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { fileAssetResourceForAccess } from "@t3tools/client-runtime/state/assets";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import { prepareHostedPreview } from "~/components/preview/previewHostingRecovery";
import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  desktopBrowserHostFor,
  isPreviewAvailableFor,
  previewRuntimeFor,
} from "~/browser/previewRuntime";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  rememberPreviewUrl,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { rememberHandoffBrowser } from "~/handoffs/handoffsStore";

import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "./browserDefaults";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export class BrowserSettingsReadError extends Data.TaggedError("BrowserSettingsReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

interface OpenUrlInPreviewInput<E> {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Profile to open under; omit for the configured default. */
  readonly profileId?: PreviewOpenInput["profileId"];
  /** Open the tab without switching the thread to it. */
  readonly background?: boolean;
  readonly onOpened?: (tabId: string) => void;
}

export async function openUrlInPreview<E>(
  input: OpenUrlInPreviewInput<E>,
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const prepared = await prepareHostedPreview(input.threadRef, input.url);
  return openPreparedUrlInPreview(input, prepared.url, prepared.navigationUrl);
}

/** Open an already recovered destination while retaining the authored URL. */
export async function openPreparedUrlInPreview<E>(
  input: OpenUrlInPreviewInput<E>,
  destinationUrl: string,
  navigationUrl?: string,
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const desktopHostId =
    runtime === "server" ? desktopBrowserHostFor(input.threadRef.environmentId) : undefined;
  const previousActiveTabId = input.background
    ? readThreadPreviewState(input.threadRef).activeTabId
    : null;
  // The server's "opened" event switches the preview tab but not the panel's
  // selection, so a changed selection means the user picked a tab themselves.
  const selectedSurface = () =>
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, input.threadRef)
      ?.id ?? null;
  const surfaceBeforeOpen = input.background ? selectedSurface() : null;
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: hostedPreviewNavigationUrl(
        { url: destinationUrl, ...(navigationUrl === undefined ? {} : { navigationUrl }) },
        runtime === "server" && desktopHostId === undefined ? input.url : destinationUrl,
      ),
      // Built here rather than via `openPreviewSession` because this path
      // maps the result differently, so the configured defaults have to be
      // applied explicitly or file/link opens would ignore them.
      viewport: browserDefaultOpenViewport(defaults),
      profileId: input.profileId ?? browserDefaultOpenProfileId(defaults),
      ...(runtime === undefined ? {} : { runtime }),
      ...(desktopHostId === undefined ? {} : { desktopHostId }),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    rememberPreviewUrl(input.threadRef, input.url);
    if (input.background) {
      updatePreviewServerSnapshot(input.threadRef, snapshot);
      // The server's "opened" event activates the new tab; hand focus back,
      // unless the user picked a tab, this one included, while the open was in flight.
      if (
        previousActiveTabId &&
        readThreadPreviewState(input.threadRef).activeTabId === snapshot.tabId &&
        selectedSurface() === surfaceBeforeOpen
      ) {
        setActivePreviewTab(input.threadRef, previousActiveTabId);
      }
      input.onOpened?.(snapshot.tabId);
      return;
    }
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
    input.onOpened?.(snapshot.tabId);
  });
}

/**
 * Opens a browser document in the integrated browser. Inside the workspace the
 * page may load sibling assets; a file outside it is served on its own.
 */
export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly canReadFiles: boolean;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  if (!isPreviewAvailableFor(input.threadRef.environmentId)) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: fileAssetResourceForAccess(
        {
          _tag: insideWorkspace ? "workspace-file" : "media-file",
          threadId: input.threadRef.threadId,
          path: input.filePath,
        },
        input.canReadFiles,
      ),
    },
  });
  if (assetResult._tag === "Failure") {
    return AsyncResult.failure(assetResult.cause);
  }
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  const result = await openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
    onOpened: (tabId) => {
      rememberHandoffBrowser(
        input.threadRef,
        tabId,
        { kind: "file", path: input.filePath },
        assetUrl,
      );
    },
  });
  return result;
}
