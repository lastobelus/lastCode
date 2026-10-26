import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
export type RenameDependencies = {
  update: (value: {
    environmentId: EnvironmentId;
    input: { threadId: ThreadId; title: string };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  finish: () => void;
};
export async function renameLastCodeThread(
  threadRef: ScopedThreadRef,
  newTitle: string,
  originalTitle: string,
  dependencies: RenameDependencies,
) {
  const { update: updateThreadMetadata, finish: finishRename } = dependencies;
  const trimmed = newTitle.trim();
  if (trimmed.length === 0) {
    toastManager.add({
      type: "warning",
      title: "Thread title cannot be empty",
    });
    finishRename();
    return;
  }
  if (trimmed === originalTitle) {
    finishRename();
    return;
  }
  const result = await updateThreadMetadata({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      title: trimmed,
    },
  });
  reportThreadOperationFailure(result, "Failed to rename thread");
  finishRename();
}
