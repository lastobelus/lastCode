import { useCallback, useMemo, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { checkTaskPermission } from "./lastcodeSidebarPermission";

export type LastCodeRenameTarget = { key: string; initialTitle: string; session: number };
export function useLastCodeThreadEditing() {
  const [renameTarget, setRenameTarget] = useState<LastCodeRenameTarget | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const nextSession = useRef(0);
  const requestRename = useCallback((ref: ScopedThreadRef, initialTitle: string) => {
    if (!checkTaskPermission(ref.environmentId)) return;
    setRenameTarget({ key: scopedThreadKey(ref), initialTitle, session: ++nextSession.current });
  }, []);
  const finishRename = useCallback((ref: ScopedThreadRef, session: number) => {
    const key = scopedThreadKey(ref);
    setRenameTarget((current) =>
      current?.key === key && current.session === session ? null : current,
    );
  }, []);
  const requestArchiveConfirmation = useCallback(
    (ref: ScopedThreadRef) => setArchiveTarget(scopedThreadKey(ref)),
    [],
  );
  const cancelArchiveConfirmation = useCallback((ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    setArchiveTarget((current) => (current === key ? null : current));
  }, []);
  const capabilities = useMemo(
    () => ({ requestRename, finishRename, requestArchiveConfirmation, cancelArchiveConfirmation }),
    [requestRename, finishRename, requestArchiveConfirmation, cancelArchiveConfirmation],
  );
  return { renameTarget, archiveTarget, capabilities };
}
export type LastCodeThreadEditingCapabilities = ReturnType<
  typeof useLastCodeThreadEditing
>["capabilities"];
