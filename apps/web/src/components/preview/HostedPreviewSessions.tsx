import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { hostRightPanel, type RightPanelSurface } from "../../rightPanelStore";
import { usePreviewSession } from "./usePreviewSession";

export function HostedPreviewSessions({
  threadRef,
  surfaces,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: readonly RightPanelSurface[];
}) {
  const sources = [
    ...new Map(
      surfaces.flatMap((surface) => {
        const source =
          surface.kind === "side-chat"
            ? scopeThreadRef(threadRef.environmentId, surface.threadId)
            : surface.kind === "preview"
              ? surface.sourceThreadRef
              : undefined;
        return source ? [[scopedThreadKey(source), source] as const] : [];
      }),
    ).values(),
  ];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- host registrations must outlive a hidden side-chat pane
  useEffect(() => {
    const cleanups = sources.map((source) => hostRightPanel(source, threadRef));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [sources, threadRef]);
  return (
    <>
      {sources.map((source) => (
        <HostedPreviewSession key={scopedThreadKey(source)} threadRef={source} />
      ))}
    </>
  );
}

function HostedPreviewSession({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}
