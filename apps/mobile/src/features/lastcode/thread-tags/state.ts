import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  ORCHESTRATION_V2_WS_METHODS,
  THREAD_TAG_RPC_METHODS,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useEnvironmentQuery } from "../../../state/query";
import { useContext, useMemo } from "react";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { environmentShell } from "../../../state/shell";
import { serverEnvironment } from "../../../state/server";
import { hiddenThreadKeys } from "@t3tools/client-runtime/state/threads";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import type { Preferences } from "../../../persistence/mobile-preferences";

export const tagCommands = {
  vocabulary: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Find thread tags",
    tag: THREAD_TAG_RPC_METHODS.vocabulary,
  }),
  query: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "Filter by thread tag",
    tag: THREAD_TAG_RPC_METHODS.query,
  }),
  set: createEnvironmentRpcCommand(connectionAtomRuntime, {
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

import { threadTagDiscoveryRevision } from "@t3tools/shared/threadTags";
import { environmentThreadShells } from "../../../state/threads";
import { collectTagPages } from "./pagination";
export function useTagDiscovery(
  scopes: readonly TagScope[],
  query: string,
  tag: string | null,
  preferredProjectId?: ProjectId,
) {
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
      connectionAtomRuntime.atom((get) => {
        get(revisionAtom);
        const alreadyHidden = get(environmentThreadShells.hiddenThreadKeysAtom);
        const loadedKeys = new Set(
          get(environmentThreadShells.threadRefsAtom).map((ref) =>
            scopedThreadKey(ref.environmentId, ref.threadId),
          ),
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
                if (tag !== null) {
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
                      return { items: result.value.threads, nextCursor: result.value.nextCursor };
                    },
                    () => !signal.aborted,
                  );
                  return { scope, entries: [], shells: threads };
                }
                const entries = await collectTagPages(
                  async (cursor) => {
                    const result = await runAtomCommand(registry, tagCommands.vocabulary, {
                      environmentId: scope.environmentId,
                      input: {
                        ...(scope.projectId ? { projectId: scope.projectId } : {}),
                        ...(preferredProjectId ? { preferredProjectId } : {}),
                        query,
                        limit: 100,
                        ...(cursor === undefined ? {} : { cursor }),
                      },
                    });
                    if (!AsyncResult.isSuccess(result)) throw squashAtomCommandFailure(result);
                    return { items: result.value.entries, nextCursor: result.value.nextCursor };
                  },
                  () => !signal.aborted,
                );
                return { scope, entries, shells: [] };
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
                    (thread) => !hidden.has(scopedThreadKey(page.scope.environmentId, thread.id)),
                  )
                  .map((thread) => presentThreadShell(page.scope.environmentId, thread)),
              ),
              incomplete: outcomes.some((outcome) => outcome.status === "rejected"),
            };
          },
          catch: (error) => (error instanceof Error ? error : new Error("Could not load tags.")),
        });
      }),
    [registry, revisionAtom, scopeKey, query, tag, preferredProjectId],
  );
  const state = useEnvironmentQuery(queryAtom);
  return {
    entries: state.data?.entries ?? [],
    threads: state.data?.threads ?? [],
    error:
      state.error ??
      (state.data?.incomplete
        ? tag === null
          ? "Could not load tags from every connection. This list may be incomplete."
          : "Could not search every connection. Results may be incomplete."
        : null),
    loading: state.isPending,
  };
}
