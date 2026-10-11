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
  capturePreviewOpenFocus,
  hiddenPreviewTabIds,
  readThreadPreviewState,
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
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
  readonly onOpened?: (tabId: string) => void;
  /** Preserve the source tab's profile when opening a link from a page. */
  readonly profileId?: PreviewOpenInput["profileId"];
  readonly background?: boolean;
}

export async function openUrlInPreview<E>(
  input: OpenUrlInPreviewInput<E>,
  focus = capturePreviewOpenFocus(input.threadRef, input.background),
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const prepared = await prepareHostedPreview(input.threadRef, input.url);
  return openPreparedUrlInPreview(input, prepared.url, prepared.navigationUrl, focus);
}

/** Open an already recovered destination while retaining the authored URL. */
export async function openPreparedUrlInPreview<E>(
  input: OpenUrlInPreviewInput<E>,
  destinationUrl: string,
  navigationUrl?: string,
  focus = capturePreviewOpenFocus(input.threadRef, input.background),
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const panelRevision = focus.userActionRevision;
  const handledOpenTabIds = readThreadPreviewState(input.threadRef).handledOpenTabIds;
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const desktopHostId =
    runtime === "server" ? desktopBrowserHostFor(input.threadRef.environmentId) : undefined;
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
      // Carry background intent through independently delivered/replayed events.
      ...(input.background ? { background: true } : {}),
      focus,
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    rememberPreviewUrl(input.threadRef, input.url);
    const creationFocusHandled =
      !handledOpenTabIds.has(snapshot.tabId) &&
      readThreadPreviewState(input.threadRef).handledOpenTabIds.has(snapshot.tabId);
    const panelChoiceChanged =
      useRightPanelStore.getState().getUserActionRevision(input.threadRef) !== panelRevision;
    if (input.background || creationFocusHandled || panelChoiceChanged) {
      // A reply is metadata once creation focus was consumed or superseded.
      // Consume pending focus too, so a later event cannot undo that choice.
      updatePreviewServerSnapshot(input.threadRef, snapshot, { consumeOpenFocus: true });
      input.onOpened?.(snapshot.tabId);
      return;
    }
    const existing = readThreadPreviewState(input.threadRef).sessions[snapshot.tabId];
    applyPreviewServerSnapshot(
      input.threadRef,
      existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot,
    );
    const state = readThreadPreviewState(input.threadRef);
    // Request start already recorded the user intent. Completion applies it
    // automatically so another in-flight open keeps its own selection order.
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        input.threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
        snapshot.tabId,
      );
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
  const focus = capturePreviewOpenFocus(input.threadRef);
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
  const result = await openUrlInPreview(
    {
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
    },
    focus,
  );
  return result;
}
