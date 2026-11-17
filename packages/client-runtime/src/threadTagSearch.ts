import type { EnvironmentThreadShell } from "./state/shell.ts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "./state/threadSearch.ts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

export function threadTagMessageSearchScope(threads: readonly ThreadSearchShell[]) {
  const messageThreadIds: Record<string, ThreadId[]> = {};
  for (const thread of threads) (messageThreadIds[thread.environmentId] ??= []).push(thread.id);
  return { messageThreadIds };
}

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

export function threadTagRelations(thread: EnvironmentThreadShell) {
  const relations: { label: string; ref: ScopedThreadRef }[] = [];
  if (thread.groupedUnderThreadId)
    relations.push({
      label: "Group",
      ref: { environmentId: thread.environmentId, threadId: thread.groupedUnderThreadId },
    });
  if (thread.delegatedFrom) relations.push({ label: "Delegated from", ref: thread.delegatedFrom });
  else if (thread.lineage.parentThreadId)
    relations.push({
      label: thread.lineage.sideChat
        ? "Side chat"
        : thread.lineage.relationshipToParent === "subagent"
          ? "Subagent"
          : "Fork",
      ref: { environmentId: thread.environmentId, threadId: thread.lineage.parentThreadId },
    });
  return relations;
}
