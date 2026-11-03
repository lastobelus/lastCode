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
  type ThreadTagVocabularyEntry,
} from "@t3tools/contracts";
import { threadTagDiscoveryRevision } from "@t3tools/shared/threadTags";
import { request } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
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

const loadVocabulary = Effect.fn("ThreadTags.vocabulary")(function* (
  input: ThreadTagVocabularyInput,
) {
  const entries: ThreadTagVocabularyEntry[] = [];
  let cursor: number | undefined;
  do {
    const page = yield* request(THREAD_TAG_RPC_METHODS.vocabulary, {
      ...input,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { entries };
});
export const tagVocabulary = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "Thread tag suggestions",
  execute: loadVocabulary,
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
