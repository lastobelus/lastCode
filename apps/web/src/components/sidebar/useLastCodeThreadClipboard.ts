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
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
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
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  return { copyPath: copyPathToClipboard, copyId: copyThreadIdToClipboard };
}
