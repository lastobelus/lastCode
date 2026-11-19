import type { ThreadCreatorOrigin } from "@t3tools/contracts";
import type { ThreadOwner } from "@t3tools/shared/threadOwnership";

export function launchCreatorOrigin(
  creator: ThreadOwner,
  topLevel: boolean | undefined,
): Extract<ThreadCreatorOrigin, { kind: "thread_launch" }> {
  return {
    kind: "thread_launch",
    environmentId: creator.environmentId,
    threadId: creator.threadId,
    ...(topLevel === true ? {} : { owned: true }),
  };
}
