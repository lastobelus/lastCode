import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";

import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { workspaceAssetResource } from "./filePreviewMode";

/** Keep a reading session intact until the reader explicitly reloads it. */
export function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** The thread is a draft the server does not know yet. */
  readonly draft: boolean;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly revision: number;
}) {
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = useMemo(
    () =>
      workspaceAssetResource({
        kind: insideWorkspace ? "workspace-file" : "media-file",
        threadRef: {
          environmentId: props.threadRef.environmentId,
          threadId: props.threadRef.threadId,
        },
        draft: props.draft,
        workspaceRoot: props.workspaceRoot,
        absolutePath: props.absolutePath,
      }),
    [
      insideWorkspace,
      props.threadRef.environmentId,
      props.threadRef.threadId,
      props.draft,
      props.workspaceRoot,
      props.absolutePath,
    ],
  );
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRevision = useRef<number | null>(null);
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
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load file preview. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, props.revision]);

  return (
    <>
      {error ? (
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
      ) : error ? null : (
        <FileSurfaceLoading />
      )}
    </>
  );
}
