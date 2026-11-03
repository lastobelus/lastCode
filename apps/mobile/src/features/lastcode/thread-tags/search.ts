import type { MessageId } from "@t3tools/contracts";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

export function taggedThreadSearch<T extends ThreadSearchShell>(
  threads: readonly T[],
  query: string,
  messageMatches: ReadonlyMap<string, { readonly messageId?: MessageId | null }>,
  nowMs: number,
) {
  const needle = foldSearchQuery(query);
  const fieldMatches = new Set(
    needle
      ? rankSearchItems(threads, (thread, options) =>
          scoreThreadSearch(needle, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : threads,
  );
  return threads.flatMap((thread) => {
    if (fieldMatches.has(thread)) return [{ thread, messageId: undefined }];
    const match = messageMatches.get(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    );
    return match === undefined ? [] : [{ thread, messageId: match.messageId }];
  });
}
