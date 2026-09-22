import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

/** Refresh and read the archived shells before destructive ownership checks. */
export function loadArchivedThreadsForEnvironment(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<EnvironmentThreadShell>> {
  const atom = archivedSnapshotAtom(environmentId);
  appAtomRegistry.refresh(atom);

  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const settle = (result: AsyncResult.AsyncResult<OrchestrationShellSnapshot, unknown>) => {
      if (result.waiting) return;
      if (result._tag === "Success") {
        unsubscribe();
        resolve(result.value.threads.map((thread) => ({ ...thread, environmentId })));
      } else if (result._tag === "Failure") {
        unsubscribe();
        reject(Cause.squash(result.cause));
      }
    };

    unsubscribe = appAtomRegistry.subscribe(atom, settle);
    settle(appAtomRegistry.get(atom));
  });
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
