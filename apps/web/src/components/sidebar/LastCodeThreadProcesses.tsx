import { useCallback } from "react";
import { Globe2Icon, TerminalIcon } from "lucide-react";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { previewEnvironment } from "../../state/preview";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { synchronizeTerminalPulse } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LastCodeThreadProcessSnapshot } from "./useLastCodeThreadProcesses";

export function LastCodeThreadProcesses({
  threadRef,
  processes,
  cleanupBlocked,
  navigateToThread,
}: {
  threadRef: ScopedThreadRef;
  processes: LastCodeThreadProcessSnapshot;
  cleanupBlocked: boolean;
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>;
}) {
  const { discoveredPorts, terminalStatus } = processes;
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port || !readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  return (
    <>
      {canOperatePreview && !cleanupBlocked && discoveredPorts.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={handleOpenDiscoveredPort}
              />
            }
          >
            <Globe2Icon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            Open localhost:{discoveredPorts[0]?.port}
            {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
              onAnimationStart={synchronizeTerminalPulse}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
