import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

export function taggedThreadSearch(
  thread: { readonly id: ThreadId; readonly environmentId: EnvironmentId; readonly title: string },
  query: string,
  messageMatches: ReadonlyMap<string, { readonly messageId?: MessageId | null }>,
) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || scoreSubsequenceMatch(thread.title.toLocaleLowerCase(), needle) !== null) {
    return { visible: true, messageId: undefined };
  }
  const match = messageMatches.get(
    threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
  );
  return { visible: match !== undefined, messageId: match?.messageId };
}
