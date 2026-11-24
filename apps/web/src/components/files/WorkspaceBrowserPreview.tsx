import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { DownloadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";

import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import {
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";
import { workspaceAssetResource } from "./filePreviewMode";

type WorkspaceBrowserPreviewProps = {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** The thread is a draft the server does not know yet. */
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly revision: number;
  readonly workspaceMutationId?: string | null;
};

export function WorkspaceBrowserPreview(props: WorkspaceBrowserPreviewProps) {
  return isPdfPreviewFile(props.absolutePath) ? (
    <WorkspacePdfPreview {...props} />
  ) : (
    <WorkspaceHtmlPreview {...props} />
  );
}

/** Keep a reading session intact until the reader explicitly reloads it. */
function WorkspaceHtmlPreview(props: WorkspaceBrowserPreviewProps) {
  const gt = useGT();
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = workspaceAssetResource({
    kind: insideWorkspace ? "workspace-file" : "media-file",
    threadRef: {
      environmentId: props.threadRef.environmentId,
      threadId: props.threadRef.threadId,
    },
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loadedRevision = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Authorizes the mounted document URL on explicit reload or interrupted connection recovery while preserving an already loaded reading session.
  useEffect(() => {
    // Reconnecting replaces the authorization callback. It can recover an
    // interrupted load, but must not replace a document already being read.
    if (loadedRevision.current === props.revision) return;
    let cancelled = false;
    // Reauthorize explicit reloads, including after a long reading session. Do not
    // subscribe the frame to workspace mutations or automatic token renewals:
    // changing its URL discards scroll position, forms and other document state.
    void refresh()
      .then((target) => {
        if (cancelled) return;
        if (!target) throw new Error("Reconnect to the environment and reload the preview.");
        const next = new URL(target);
        next.searchParams.set("preview-revision", String(props.revision));
        loadedRevision.current = props.revision;
        setUrl(next.toString());
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, props.revision]);
  const error = gt("Unable to load file preview. Reload to try again.");

  return (
    <>
      {failed ? (
        url ? (
          <FileSurfaceNotice>{error}</FileSurfaceNotice>
        ) : (
          <FileSurfaceFailure message={error} />
        )
      ) : null}
      {url ? (
        <BrowserDocumentFrame
          src={url}
          title={props.title}
          pdf={isPdfPreviewFile(props.absolutePath)}
        />
      ) : failed ? null : (
        <FileSurfaceLoading />
      )}
    </>
  );
}

function WorkspacePdfPreview(props: WorkspaceBrowserPreviewProps) {
  const gt = useGT();
  const resource = workspaceAssetResource({
    kind: "media-file",
    threadRef: props.threadRef,
    draft: props.draft,
    workspaceRoot: props.workspaceRoot,
    absolutePath: props.absolutePath,
  });
  const workspaceMutationId = props.workspaceMutationId ?? null;
  const assetUrl = useAssetUrlState(props.environmentId, resource, workspaceMutationId);
  const fileRevision = assetUrl._tag === "Success" ? assetUrl.fileRevision : undefined;
  const revision = fileRevision ?? workspaceMutationId;

  if (assetUrl._tag === "Failure") {
    return <FileSurfaceFailure message={gt("Unable to load file preview.")} />;
  }
  if (assetUrl._tag !== "Success" || (fileRevision === undefined && assetUrl.waiting)) {
    return <FileSurfaceLoading />;
  }
  const revisionSuffix =
    revision === null
      ? ""
      : `${assetUrl.url.includes("?") ? "&" : "?"}${fileRevision !== undefined ? "file" : "workspace"}-revision=${encodeURIComponent(revision)}`;
  const documentId = `${props.environmentId}:${resource._tag}:${props.threadRef.threadId}:${props.absolutePath}`;
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      documentKey={`${documentId}:${revision}:${props.revision}`}
      documentId={documentId}
      title={props.title}
      pdf
      threadRef={props.threadRef}
      pdfActions={
        <WorkspacePdfSaveAction
          environmentId={props.environmentId}
          resource={resource}
          name={props.title}
        />
      }
    />
  );
}

function WorkspacePdfSaveAction(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly name: string;
}) {
  const gt = useGT();
  const [saving, setSaving] = useState(false);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  return (
    <FileSurfaceAction
      label={saving ? gt("Preparing file…") : gt("Save file")}
      disabled={saving}
      onPress={() => {
        setSaving(true);
        void (async () => {
          const url = await refreshAssetUrl();
          if (!url) throw new Error(gt("Reconnect to the environment and try again."));
          const response = await fetch(url);
          if (!response.ok) throw new Error(gt("The file could not be loaded. Try again."));
          // Blob downloads keep desktop's custom app scheme from navigating to an external browser.
          const downloadUrl = URL.createObjectURL(await response.blob());
          setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
          const anchor = document.createElement("a");
          anchor.href = downloadUrl;
          anchor.download = props.name.split(/[\\/]/).at(-1) || props.name;
          anchor.click();
        })()
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: gt("Could not save file"),
              description: thrownErrorMessage(cause, m) ?? gt("Please try again."),
            }),
          )
          .finally(() => setSaving(false));
      }}
    >
      <DownloadIcon className="size-3.5" />
    </FileSurfaceAction>
  );
}
