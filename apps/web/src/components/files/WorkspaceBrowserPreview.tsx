import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";

import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";

/** Keep a reading session intact until the reader explicitly reloads it. */
export function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly revision: number;
}) {
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = useMemo(
    () => ({
      _tag: insideWorkspace ? ("workspace-file" as const) : ("media-file" as const),
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [insideWorkspace, props.threadRef.threadId, props.absolutePath],
  );
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedDocument = useRef(false);
  const requestedRevision = useRef<number | null>(null);
  useEffect(() => {
    // Reconnecting replaces the authorization callback. It can recover an
    // initial offline load, but must not replace a document already being read.
    if (hasLoadedDocument.current && requestedRevision.current === props.revision) return;
    requestedRevision.current = props.revision;
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
        hasLoadedDocument.current = true;
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
