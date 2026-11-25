import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import {
  usePreviewProcessControlsSupported,
  useThreadPreviewLeases,
} from "../../state/previewHosting";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { terminalStatusFromRunningIds } from "../ThreadStatusIndicators";

export function useLastCodeThreadProcesses(threadRef: ScopedThreadRef) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const previews = useThreadPreviewLeases(threadRef);
  const supportsProcessControls = usePreviewProcessControlsSupported(threadRef.environmentId);
  const hasStoppableProcesses =
    supportsProcessControls && (runningTerminalIds.length > 0 || previews.length > 0);
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  return { runningTerminalIds, discoveredPorts, hasStoppableProcesses, terminalStatus };
}
export type LastCodeThreadProcessSnapshot = ReturnType<typeof useLastCodeThreadProcesses>;
