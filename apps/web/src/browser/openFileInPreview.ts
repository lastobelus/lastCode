import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { isPreviewAvailableFor, previewRuntimeFor } from "~/browser/previewRuntime";
import {
  applyPreviewServerSnapshot,
  capturePreviewOpenFocus,
  hiddenPreviewTabIds,
  readThreadPreviewState,
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";

import { resolveBrowserDefaults } from "./browserDefaults";

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

export async function openUrlInPreview<E>(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly url: string;
    readonly openPreview: OpenPreviewMutation<E>;
    /** Preserve the source tab's profile when opening a link from a page. */
    readonly profileId?: PreviewOpenInput["profileId"];
    readonly background?: boolean;
  },
  focus = capturePreviewOpenFocus(rightPanelHostRef(input.threadRef), input.background),
): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  // Capture the panel host before an await can unmount the side chat.
  const threadRef = rightPanelHostRef(input.threadRef);
  const panelRevision = focus.userActionRevision;
  const handledOpenTabIds = readThreadPreviewState(threadRef).handledOpenTabIds;
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(threadRef.environmentId);
  const result = await input.openPreview({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      url: input.url,
      viewport: defaults.viewport,
      profileId: input.profileId ?? defaults.profileId,
      ...(runtime === undefined ? {} : { runtime }),
      // Carry background intent through independently delivered/replayed events.
      ...(input.background ? { background: true } : {}),
      focus,
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    rememberPreviewUrl(threadRef, input.url);
    const creationFocusHandled =
      !handledOpenTabIds.has(snapshot.tabId) &&
      readThreadPreviewState(threadRef).handledOpenTabIds.has(snapshot.tabId);
    const panelChoiceChanged =
      useRightPanelStore.getState().getUserActionRevision(threadRef) !== panelRevision;
    if (input.background || creationFocusHandled || panelChoiceChanged) {
      // A reply is metadata once creation focus was consumed or superseded.
      // Consume pending focus too, so a later event cannot undo that choice.
      updatePreviewServerSnapshot(threadRef, snapshot, { consumeOpenFocus: true });
      return;
    }
    const existing = readThreadPreviewState(threadRef).sessions[snapshot.tabId];
    applyPreviewServerSnapshot(
      threadRef,
      existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot,
    );
    const state = readThreadPreviewState(threadRef);
    // Request start already recorded the user intent. Completion applies it
    // automatically so another in-flight open keeps its own selection order.
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        threadRef,
        Object.keys(state.sessions),
        hiddenPreviewTabIds(state.sessions),
        snapshot.tabId,
      );
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
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
  const hostRef = rightPanelHostRef(input.threadRef);
  const focus = capturePreviewOpenFocus(hostRef);
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
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
  return openUrlInPreview(
    {
      threadRef: hostRef,
      url: assetUrl,
      openPreview: input.openPreview,
    },
    focus,
  );
}
