import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import { AuthFilesystemReadScope } from "@t3tools/contracts";
import type {
  AssetResource,
  ScopedThreadRef,
  EnvironmentId,
  PreviewNavigateInput,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { fileAssetResourceForAccess } from "@t3tools/client-runtime/state/assets";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { requestHostedPreviewRefresh } from "~/browser/hostedPreviewRefresh";
import { prepareHostedPreview } from "~/components/preview/previewHostingRecovery";
import { previewBridge } from "~/components/preview/previewBridge";
import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  isBrowserPreviewFile,
  openPreparedUrlInPreview,
  type OpenPreviewMutation,
  type openFileInPreview,
} from "~/browser/openFileInPreview";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readThreadPreviewState, applyPreviewServerSnapshot } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { assetEnvironment } from "~/state/assets";
import { readProjects, readThreadShell } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  type HandoffEntry,
  handoffBrowserTarget,
  handoffTargetKey,
  recordHandoff,
  rememberHandoffBrowser,
  handoffUrlsEqual,
} from "./handoffsStore";

/** A browser tab that navigated away must not be hijacked when reopening a handoff. */
function findHandoffBrowser(
  ref: ScopedThreadRef,
  entry: HandoffEntry,
  destinationUrl?: string,
): string | undefined {
  const state = readThreadPreviewState(ref);
  for (const snapshot of Object.values(state.sessions)) {
    if (snapshot.navStatus._tag === "Idle") continue;
    const url = snapshot.navStatus.url;
    if (
      entry.target.kind === "url" &&
      (handoffUrlsEqual(url, entry.target.url) ||
        (destinationUrl !== undefined && handoffUrlsEqual(url, destinationUrl)))
    )
      return snapshot.tabId;
    const binding = handoffBrowserTarget(ref, snapshot.tabId);
    if (
      binding &&
      handoffUrlsEqual(binding.url, url) &&
      handoffTargetKey(binding.target) === entry.id
    )
      return snapshot.tabId;
  }
  return undefined;
}

interface HandoffOpenOperations {
  openPreview: OpenPreviewMutation;
  navigatePreview: (input: {
    environmentId: EnvironmentId;
    input: PreviewNavigateInput;
  }) => Promise<AtomCommandResult<PreviewSessionSnapshot, unknown>>;
  createAssetUrl: Parameters<typeof openFileInPreview>[0]["createAssetUrl"];
}

function rendersHandoffBrowserNatively(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | undefined,
) {
  return Boolean(
    previewBridge &&
    (snapshot?.runtime !== "server" ||
      rendersServerTabNatively(
        ref.environmentId,
        appAtomRegistry.get(primaryEnvironmentIdAtom),
        snapshot,
      )),
  );
}

async function navigateHandoffBrowser(
  ref: ScopedThreadRef,
  tabId: string,
  url: string,
  navigatePreview: HandoffOpenOperations["navigatePreview"],
  serverUrl = url,
) {
  const snapshot = readThreadPreviewState(ref).sessions[tabId];
  const native = rendersHandoffBrowserNatively(ref, snapshot);
  if (snapshot?.runtime === "server" && !native) {
    // Streamed tabs require their existing viewer's control channel. Keep the
    // intent until that viewer can send it, and mint navigation access there.
    requestHostedPreviewRefresh(ref, tabId, serverUrl);
  } else if (native && previewBridge) {
    // Native navigation mirrors its resulting URL back to the server.
    await previewBridge.navigate(
      previewRuntimeTabId(ref, readThreadPreviewState(ref).serverEpoch, tabId),
      url,
    );
  } else {
    const result = await navigatePreview({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, tabId, url },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    applyPreviewServerSnapshot(ref, result.value);
  }
}

export async function openHandoff(
  ref: ScopedThreadRef,
  entry: HandoffEntry,
  { openPreview, navigatePreview, createAssetUrl }: HandoffOpenOperations,
): Promise<void> {
  try {
    const panels = useRightPanelStore.getState();
    const target = entry.target;
    if (target.kind === "pull-request") {
      panels.openPullRequest(ref, target);
    } else if (target.kind === "url") {
      const prepared = await prepareHostedPreview(ref, target.url, "resource");
      const existing = findHandoffBrowser(ref, entry, prepared.url);
      if (existing) {
        const snapshot = readThreadPreviewState(ref).sessions[existing];
        const streamed =
          snapshot?.runtime === "server" && !rendersHandoffBrowserNatively(ref, snapshot);
        if (prepared.restarted || snapshot?.navStatus._tag === "LoadFailed") {
          const navigation = streamed ? prepared : await prepareHostedPreview(ref, target.url);
          // Navigation access can take time; a newer user navigation wins.
          if (findHandoffBrowser(ref, entry, prepared.url) !== existing) return;
          await navigateHandoffBrowser(
            ref,
            existing,
            hostedPreviewNavigationUrl(navigation),
            navigatePreview,
            target.url,
          );
        }
        rememberHandoffBrowser(ref, existing, target, streamed ? target.url : prepared.url);
        panels.openBrowser(ref, existing);
      } else {
        const result = await openPreparedUrlInPreview(
          {
            threadRef: ref,
            url: target.url,
            openPreview,
            onOpened: (tabId) => rememberHandoffBrowser(ref, tabId, target, prepared.url),
          },
          prepared.url,
          (await prepareHostedPreview(ref, target.url)).navigationUrl,
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
    } else {
      const thread = readThreadShell(ref);
      const project = readProjects().find(
        (project) =>
          project.environmentId === ref.environmentId && project.id === thread?.projectId,
      );
      const workspaceRoot = thread?.worktreePath ?? project?.workspaceRoot;
      const browserFile = target.kind === "file" && isBrowserPreviewFile(target.path);
      const existing = findHandoffBrowser(ref, entry);
      // Refresh the same asset query used by the Files pane, even when its tab
      // already exists. An old cached capability must not survive a reopen.
      if (browserFile || target.kind === "attachment") {
        const resource: AssetResource =
          target.kind === "attachment"
            ? {
                _tag: "attachment",
                attachmentId: target.attachment.id,
                fileName: target.attachment.name,
                mimeType: target.attachment.mimeType,
                disposition: "inline",
              }
            : {
                _tag:
                  mediaFileReference(target.path, workspaceRoot).relativePath !== undefined
                    ? "workspace-file"
                    : "media-file",
                threadId: ref.threadId,
                path: target.path,
              };
        const result = await createAssetUrl({
          environmentId: ref.environmentId,
          input: {
            resource: fileAssetResourceForAccess(
              resource,
              readEnvironmentScope(ref.environmentId, AuthFilesystemReadScope),
            ),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (existing) {
          const connection = readPreparedConnection(ref.environmentId);
          const url = connection
            ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl)
            : null;
          if (!url) throw new Error("The environment is not connected.");
          await navigateHandoffBrowser(ref, existing, url, navigatePreview);
          rememberHandoffBrowser(ref, existing, target, url);
        }
      }
      if (existing) panels.openBrowser(ref, existing);
      else if (target.kind === "file")
        panels.openFile(
          ref,
          mediaFileReference(target.path, workspaceRoot).relativePath ?? target.path,
          target.line,
        );
      else panels.openAttachment(ref, target.attachment);
    }
    recordHandoff(ref, entry.target);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open handoff",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function useOpenHandoff() {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const navigatePreview = useAtomCommand(previewEnvironment.navigate, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(
    (ref: ScopedThreadRef, entry: HandoffEntry) =>
      openHandoff(ref, entry, { openPreview, navigatePreview, createAssetUrl }),
    [createAssetUrl, navigatePreview, openPreview],
  );
}
