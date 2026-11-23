import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadShells } from "../../state/threads";

/** Select the open thread's own row when it is listed, or its listed ancestor. */
export function useSidebarRowThreadKey(openThreadKey: string | null): string | null {
  const threads = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const pendingChildThreadKeys = useAtomValue(
    environmentThreadShells.annotationPendingChildThreadKeysAtom,
  );
  const openThreadRef = openThreadKey === null ? null : parseScopedThreadKey(openThreadKey);
  if (openThreadRef === null) return openThreadKey;
  const rowRef = resolveListedAncestorThreadRef(openThreadRef, threads, pendingChildThreadKeys);
  return scopedThreadKey(rowRef.environmentId, rowRef.threadId);
}
