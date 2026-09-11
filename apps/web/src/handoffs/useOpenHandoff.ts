import type {
  AssetResource,
  ScopedThreadRef,
  EnvironmentId,
  PreviewNavigateInput,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  isBrowserPreviewFile,
  openUrlInPreview,
  type OpenPreviewMutation,
  type openFileInPreview,
} from "~/browser/openFileInPreview";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readThreadPreviewState, applyPreviewServerSnapshot } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { assetEnvironment } from "~/state/assets";
import { readProjects, readThreadShell } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  type HandoffEntry,
  handoffBrowserTarget,
  handoffTargetKey,
  recordHandoff,
  rememberHandoffBrowser,
  handoffUrlsEqual,
} from "./handoffsStore";

/** A browser tab that navigated away must not be hijacked when reopening a handoff. */
export function findHandoffBrowser(ref: ScopedThreadRef, entry: HandoffEntry): string | undefined {
  const state = readThreadPreviewState(ref);
  for (const snapshot of Object.values(state.sessions)) {
    if (snapshot.navStatus._tag === "Idle") continue;
    const url = snapshot.navStatus.url;
    if (entry.target.kind === "url" && handoffUrlsEqual(url, entry.target.url))
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

async function navigateHandoffBrowser(
  ref: ScopedThreadRef,
  tabId: string,
  url: string,
  navigatePreview: HandoffOpenOperations["navigatePreview"],
) {
  if (previewBridge) {
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
      const existing = findHandoffBrowser(ref, entry);
      if (existing) {
        if (readThreadPreviewState(ref).sessions[existing]?.navStatus._tag === "LoadFailed") {
          await navigateHandoffBrowser(ref, existing, target.url, navigatePreview);
        }
        panels.openBrowser(ref, existing);
      } else {
        const result = await openUrlInPreview({
          threadRef: ref,
          url: target.url,
          openPreview,
          onOpened: (tabId) => rememberHandoffBrowser(ref, tabId, target, target.url),
        });
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
          input: { resource },
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
