import { threadKey } from "@t3tools/client-runtime/state/entities";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ORCHESTRATION_V2_WS_METHODS,
  THREAD_TAG_RPC_METHODS,
  ThreadTagDiscoveryError,
  type EnvironmentId,
  type ProjectId,
  type ThreadTagVocabularyEntry,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useGT } from "gt-react-native";
import { useEnvironmentQuery } from "../../../state/query";
import { useContext, useMemo } from "react";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { environmentShell } from "../../../state/shell";
import { serverEnvironment } from "../../../state/server";
import { hiddenThreadKeys } from "@t3tools/client-runtime/state/threads";
import { loadThreadTagVocabulary } from "@t3tools/client-runtime/thread-tag-discovery";
import type { Preferences } from "../../../persistence/mobile-preferences";

export const tagCommands = {
  query: createEnvironmentRpcCommand(connectionAtomRuntime, {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- This label identifies the operation in logs.
    label: "Filter by thread tag",
    tag: THREAD_TAG_RPC_METHODS.query,
  }),
  set: createEnvironmentRpcCommand(connectionAtomRuntime, {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- This label identifies the operation in logs.
    label: "Update thread tag",
    tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  }),
};

export function useTagPreferences() {
  const stored = useAtomValue(mobilePreferencesAtom);
  const preferences: Preferences = AsyncResult.getOrElse(stored, () => ({}));
  return {
    header: preferences.lastcodeThreadTagsHeaderEnabled !== false,
    sidebar: preferences.lastcodeThreadTagsSidebarEnabled !== false,
  };
}

export interface TagScope {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
}

import { threadTagDiscoveryRevision, mergeThreadTagVocabulary } from "@t3tools/shared/threadTags";
import { environmentThreadShells } from "../../../state/threads";
import { collectTagPages } from "./pagination";
const vocabularyRevision = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(environmentShell.stateValueAtom(environmentId), (state) =>
    threadTagDiscoveryRevision({
      generation: state.generation,
      removals: state.removedAt,
      snapshot: Option.getOrNull(state.snapshot),
    }),
  ),
);
const vocabularyQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- This label identifies the query in diagnostics and cache keys.
  label: "Thread tag suggestions",
  execute: loadThreadTagVocabulary,
  staleTimeMs: Infinity,
  refreshTrigger: ({ environmentId }) => vocabularyRevision(environmentId),
});
const vocabularyScope = Atom.family((key: string) => {
  const target = JSON.parse(key) as { scope: TagScope; preferredProjectId?: ProjectId };
  return Atom.make((get) => {
    const hidingAnywhere = get(environmentThreadShells.anyEnvironmentHidingAtom);
    return get(
      vocabularyQuery({
        environmentId: target.scope.environmentId,
        input: {
          ...(target.scope.projectId ? { projectId: target.scope.projectId } : {}),
          ...(target.preferredProjectId ? { preferredProjectId: target.preferredProjectId } : {}),
          uiVisibility: {
            environmentId: target.scope.environmentId,
            hiddenTags: get(serverEnvironment.hiddenThreadTagsAtom(target.scope.environmentId)),
            hiddenThreadKeys: hidingAnywhere
              ? [...get(environmentThreadShells.hiddenThreadKeysAtom)]
              : [],
            loadedThreadKeys: hidingAnywhere
              ? get(environmentThreadShells.threadRefsAtom).map((ref) => threadKey(ref))
              : [],
            hidingAnywhere,
          },
        },
      }),
    );
  });
});
interface TagDiscoveryData {
  readonly entries: readonly ThreadTagVocabularyEntry[];
  readonly threads: ReturnType<typeof presentThreadShell>[];
  readonly incomplete: boolean;
}
const vocabularyPages = Atom.family((key: string) => {
  const target = JSON.parse(key) as { scopes: TagScope[]; preferredProjectId?: ProjectId };
  return Atom.make((get) => {
    const entries: ThreadTagVocabularyEntry[] = [];
    let loading = false;
    let incomplete = false;
    for (const scope of target.scopes) {
      const result = get(
        vocabularyScope(JSON.stringify({ scope, preferredProjectId: target.preferredProjectId })),
      );
      loading ||= result.waiting || AsyncResult.isInitial(result);
      incomplete ||= AsyncResult.isFailure(result);
      if (AsyncResult.isSuccess(result) && !result.waiting) entries.push(...result.value.entries);
    }
    return AsyncResult.success<TagDiscoveryData>(
      { entries, threads: [], incomplete },
      { waiting: loading },
    );
  });
});
export function useTagDiscovery(
  scopes: readonly TagScope[],
  query: string,
  tag: string | null,
  preferredProjectId?: ProjectId,
) {
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const scopeKey = JSON.stringify(scopes);
  const revisionAtom = useMemo(
    () =>
      Atom.make((get) => {
        const targets: TagScope[] = JSON.parse(scopeKey);
        return JSON.stringify(
          targets.map((scope) => {
            const state = get(environmentShell.stateValueAtom(scope.environmentId));
            return [
              get(serverEnvironment.hiddenThreadTagsAtom(scope.environmentId)),
              threadTagDiscoveryRevision({
                generation: state.generation,
                removals: state.removedAt,
                snapshot: Option.getOrNull(state.snapshot),
              }),
            ];
          }),
        );
      }),
    [scopeKey],
  );
  const queryAtom = useMemo(
    () =>
      tag === null
        ? vocabularyPages(JSON.stringify({ scopes: JSON.parse(scopeKey), preferredProjectId }))
        : connectionAtomRuntime.atom((get) => {
            get(revisionAtom);
            const alreadyHidden = get(environmentThreadShells.hiddenThreadKeysAtom);
            const loadedKeys = new Set(
              get(environmentThreadShells.threadRefsAtom).map((ref) => threadKey(ref)),
            );
            const hidingAnywhere = get(environmentThreadShells.anyEnvironmentHidingAtom);
            const targets: TagScope[] = JSON.parse(scopeKey);
            const hiddenTags = new Map(
              targets.map((scope) => [
                scope.environmentId,
                get(serverEnvironment.hiddenThreadTagsAtom(scope.environmentId)),
              ]),
            );
            return Effect.tryPromise({
              try: async (signal) => {
                const outcomes = await Promise.allSettled(
                  targets.map(async (scope) => {
                    const threads = await collectTagPages(
                      async (cursor) => {
                        const result = await runAtomCommand(registry, tagCommands.query, {
                          environmentId: scope.environmentId,
                          input: {
                            ...(scope.projectId ? { projectId: scope.projectId } : {}),
                            tag,
                            mode: "subtree",
                            limit: 100,
                            ...(cursor === undefined ? {} : { cursor }),
                          },
                        });
                        if (!AsyncResult.isSuccess(result)) throw squashAtomCommandFailure(result);
                        return {
                          items: result.value.threads,
                          nextCursor: result.value.nextCursor,
                        };
                      },
                      () => !signal.aborted,
                    );
                    return { scope, entries: [], shells: threads };
                  }),
                );
                const pages = outcomes.flatMap((outcome) =>
                  outcome.status === "fulfilled" ? [outcome.value] : [],
                );
                const hidden = hiddenThreadKeys(
                  pages.map((page) => ({
                    environmentId: page.scope.environmentId,
                    threads: page.shells,
                    hiddenTags: hiddenTags.get(page.scope.environmentId) ?? null,
                  })),
                  alreadyHidden,
                  loadedKeys,
                  hidingAnywhere,
                );
                return {
                  entries: pages.flatMap((page) => page.entries),
                  threads: pages.flatMap((page) =>
                    page.shells
                      .filter(
                        (thread) =>
                          !hidden.has(
                            threadKey({
                              environmentId: page.scope.environmentId,
                              threadId: thread.id,
                            }),
                          ),
                      )
                      .map((thread) => presentThreadShell(page.scope.environmentId, thread)),
                  ),
                  incomplete: outcomes.some((outcome) => outcome.status === "rejected"),
                };
              },
              catch: (cause) =>
                new ThreadTagDiscoveryError({
                  message: cause instanceof Error ? cause.message : "Could not load tags.",
                  cause,
                }),
            });
          }),
    [registry, revisionAtom, scopeKey, tag, preferredProjectId],
  );
  const state = useEnvironmentQuery(queryAtom);
  return {
    entries: mergeThreadTagVocabulary([state.data?.entries ?? []], query),
    // Cached data was filtered under the previous privacy state, so only expose a settled read.
    threads: state.successResult?.value.threads ?? [],
    error:
      state.error ??
      (state.data?.incomplete
        ? tag === null
          ? gt("Could not load tags from every connection. This list may be incomplete.")
          : gt("Could not search every connection. Results may be incomplete.")
        : null),
    loading: state.isPending,
  };
}
