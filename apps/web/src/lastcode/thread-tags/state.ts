import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { ORCHESTRATION_V2_WS_METHODS, THREAD_TAG_RPC_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { threadEnvironment } from "../../state/threads";
import { useAtomValue } from "@effect/atom-react";

// The existing shell stream invalidates discovery. Streaming text is deliberately absent.
const tagRevision = Atom.family(
  (environmentId: Parameters<typeof threadEnvironment.snapshotAtom>[0]) =>
    Atom.map(threadEnvironment.snapshotAtom(environmentId), (snapshot) =>
      JSON.stringify(
        snapshot?.threads.map((thread) => [
          thread.id,
          thread.projectId,
          thread.tags,
          thread.archivedAt,
          thread.deletedAt,
        ]),
      ),
    ),
);

export const tagVocabulary = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "Thread tag suggestions",
  tag: THREAD_TAG_RPC_METHODS.vocabulary,
  staleTimeMs: 0,
  refreshTrigger: ({ environmentId }) => tagRevision(environmentId),
});
export const tagMatches = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "Threads with tag",
  tag: THREAD_TAG_RPC_METHODS.query,
  staleTimeMs: 0,
  refreshTrigger: ({ environmentId }) => tagRevision(environmentId),
});
export const setThreadTag = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Update thread tag",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

export function useTagEnvironmentIds() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return [...enabledEnvironmentIds(catalog)];
}

// Session-only display state; never changes canonical thread membership or settings.
export const useTagFilterStore = create<{
  tag: string | null;
  archived: boolean;
  select: (tag: string | null) => void;
  setArchived: (archived: boolean) => void;
}>((set) => ({
  tag: null,
  archived: false,
  select: (tag) => set(tag === null ? { tag, archived: false } : { tag }),
  setArchived: (archived) => set({ archived }),
}));
