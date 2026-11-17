import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  ORCHESTRATION_V2_WS_METHODS,
  THREAD_TAG_RPC_METHODS,
  type ThreadTagVocabularyInput,
} from "@t3tools/contracts";
import { threadTagDiscoveryRevision } from "@t3tools/shared/threadTags";
import { loadThreadTagVocabulary } from "@t3tools/client-runtime/thread-tag-discovery";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { useAtomValue } from "@effect/atom-react";

// The existing shell stream invalidates discovery. Streaming text is deliberately absent.
const tagRevision = Atom.family(
  (environmentId: Parameters<typeof environmentShell.stateValueAtom>[0]) =>
    Atom.map(environmentShell.stateValueAtom(environmentId), (state) =>
      threadTagDiscoveryRevision({
        generation: state.generation,
        removals: state.removedAt,
        snapshot: Option.getOrNull(state.snapshot),
      }),
    ),
);

const vocabularyQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "Thread tag suggestions",
  execute: loadThreadTagVocabulary,
  staleTimeMs: Infinity,
  refreshTrigger: ({ environmentId }) => tagRevision(environmentId),
});
export const vocabularyScope = Atom.family((key: string) => {
  const target = JSON.parse(key) as {
    environmentId: Parameters<typeof tagRevision>[0];
    input: ThreadTagVocabularyInput;
  };
  return Atom.make((get) => {
    const hidingAnywhere = get(environmentThreadShells.anyEnvironmentHidingAtom);
    return get(
      vocabularyQuery({
        environmentId: target.environmentId,
        input: {
          ...target.input,
          uiVisibility: {
            environmentId: target.environmentId,
            hiddenTags: get(serverEnvironment.hiddenThreadTagsAtom(target.environmentId)),
            hiddenThreadKeys: hidingAnywhere
              ? [...get(environmentThreadShells.hiddenThreadKeysAtom)]
              : [],
            loadedThreadKeys: hidingAnywhere
              ? get(environmentThreadShells.threadRefsAtom).map(threadKey)
              : [],
            hidingAnywhere,
          },
        },
      }),
    );
  });
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
