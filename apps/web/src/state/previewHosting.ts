import type {
  EnvironmentId,
  PreviewHostingLeaseMetadata,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { previewEnvironment } from "./preview";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";
import { environmentServerConfigsAtom } from "./server";

const EMPTY_PREVIEW_LEASES: ReadonlyArray<PreviewHostingLeaseMetadata> = [];

export function usePreviewProcessControlsSupported(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentServerConfigsAtom,
    (configs) =>
      environmentId !== null &&
      configs.get(environmentId)?.environment.capabilities.previewHostingProcessControl === true,
  );
}

export function useThreadPreviewLeases(threadRef: ScopedThreadRef | null) {
  const leases = useEnvironmentQuery(
    threadRef === null
      ? null
      : previewEnvironment.hostingLeases({ environmentId: threadRef.environmentId, input: {} }),
  ).data;
  return useMemo(
    () => leases?.filter((lease) => lease.threadId === threadRef?.threadId) ?? EMPTY_PREVIEW_LEASES,
    [leases, threadRef?.threadId],
  );
}

export function useStopThreadProcesses() {
  const stop = useAtomCommand(previewEnvironment.hostingStopThread, { reportFailure: false });
  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const startedAt = performance.now();
      const toastId = toastManager.add({
        type: "loading",
        title: "Stopping all previews & processes…",
      });
      const result = await stop({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (result._tag === "Success") {
        toastManager.update(toastId, {
          type: "success",
          title: "All previews & processes stopped",
          // Zero disables auto-dismiss, so use one millisecond once the minimum has elapsed.
          timeout: Math.max(1, 3_000 - (performance.now() - startedAt)),
        });
      } else if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
      } else {
        const error = squashAtomCommandFailure(result);
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Could not stop all previews and processes",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return result;
    },
    [stop],
  );
}
