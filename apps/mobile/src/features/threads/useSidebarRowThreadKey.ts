import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveListedAncestorThreadRef } from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadShells } from "../../state/threads";

const NULL_ROW_KEY_ATOM = Atom.make<string | null>(null);

// Deriving the resolved key inside an atom family avoids subscribing to the full shell list when
// no row is selected (phone portrait) and avoids re-rendering on shell frames that do not change
// the open thread's listed ancestor row.
const sidebarRowThreadKeyAtom = Atom.family((openThreadKey: string) =>
  Atom.make((get): string | null => {
    const openThreadRef = parseScopedThreadKey(openThreadKey);
    if (openThreadRef === null) return openThreadKey;
    const threads = get(environmentThreadShells.quietThreadShellsAtom);
    const pendingChildThreadKeys = get(
      environmentThreadShells.annotationPendingChildThreadKeysAtom,
    );
    const rowRef = resolveListedAncestorThreadRef(openThreadRef, threads, pendingChildThreadKeys);
    return scopedThreadKey(rowRef.environmentId, rowRef.threadId);
  }),
);

/** Select the open thread's own row when it is listed, or its listed ancestor. */
export function useSidebarRowThreadKey(openThreadKey: string | null): string | null {
  return useAtomValue(
    openThreadKey === null ? NULL_ROW_KEY_ATOM : sidebarRowThreadKeyAtom(openThreadKey),
  );
}
