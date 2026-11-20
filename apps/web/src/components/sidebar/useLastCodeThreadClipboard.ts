import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { ThreadId } from "@t3tools/contracts";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "../ui/toast";
export function useLastCodeThreadClipboard() {
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: m(msg("Thread ID copied")),
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to copy thread ID")),
          description: error instanceof Error ? error.message : m(msg("An error occurred.")),
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: m(msg("Path copied")),
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to copy path")),
          description: error instanceof Error ? error.message : m(msg("An error occurred.")),
        }),
      );
    },
  });
  return { copyPath: copyPathToClipboard, copyId: copyThreadIdToClipboard };
}
