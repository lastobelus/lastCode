import { threadKey } from "@t3tools/client-runtime/state/entities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { hiddenThreadKeys } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { environmentThreadShells } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { tagMatches } from "./state";

export const tagResultPages = Atom.family((key: string) => {
  const target = JSON.parse(key) as {
    environmentIds: EnvironmentId[];
    tag: string;
    archived: boolean;
  };
  return Atom.make((get) => {
    let loading = false;
    let failed = false;
    const environments = target.environmentIds.map((environmentId) => {
      const threads: OrchestrationV2ThreadShell[] = [];
      const reads: { snapshotSequence: number; threads: readonly OrchestrationV2ThreadShell[] }[] =
        [];
      let cursor = 0;
      while (true) {
        const result = get(
          tagMatches({
            environmentId,
            input: { tag: target.tag, archived: target.archived, cursor, limit: 100 },
          }),
        );
        const page = Option.getOrNull(AsyncResult.value(result));
        loading ||= result.waiting || AsyncResult.isInitial(result);
        failed ||= AsyncResult.isFailure(result);
        threads.push(...(page?.threads ?? []));
        if (page) reads.push({ snapshotSequence: page.snapshotSequence, threads: page.threads });
        if (page?.nextCursor == null) break;
        if (page.nextCursor <= cursor) {
          failed = true;
          break;
        }
        cursor = page.nextCursor;
      }
      return { environmentId, threads, reads };
    });
    return { environments, loading, failed };
  });
});

export const tagResultRows = Atom.family((key: string) =>
  Atom.make((get) => {
    const result = get(tagResultPages(key));
    const environments = result.environments.map((environment) => ({
      ...environment,
      hiddenTags: get(serverEnvironment.hiddenThreadTagsAtom(environment.environmentId)),
    }));
    const hidden = hiddenThreadKeys(
      environments,
      get(environmentThreadShells.hiddenThreadKeysAtom),
      new Set(get(environmentThreadShells.threadRefsAtom).map((ref) => threadKey(ref))),
      get(environmentThreadShells.anyEnvironmentHidingAtom),
    );
    return {
      ...result,
      threads: environments
        .flatMap(({ environmentId, threads }) =>
          threads
            .filter((thread) => !hidden.has(threadKey({ environmentId, threadId: thread.id })))
            .map((thread) => presentThreadShell(environmentId, thread)),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            scopedThreadKey(scopeThreadRef(a.environmentId, a.id)).localeCompare(
              scopedThreadKey(scopeThreadRef(b.environmentId, b.id)),
            ),
        ),
    };
  }),
);

export const tagResultShells = Atom.family((key: string) => {
  const { queryKey, environmentId } = JSON.parse(key) as {
    queryKey: string;
    environmentId: EnvironmentId;
  };
  return Atom.map(
    tagResultPages(queryKey),
    (result) =>
      result.environments.find((environment) => environment.environmentId === environmentId)
        ?.reads ?? [],
  );
});
