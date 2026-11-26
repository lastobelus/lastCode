import {
  type ThreadTagQueryInput,
  type ThreadTagQueryResult,
  type ThreadTagVocabularyInput,
  type ThreadTagVocabularyResult,
  ThreadTagDiscoveryError,
} from "@t3tools/contracts";
import {
  hiddenThreadKeys,
  matchesThreadTag,
  rankThreadTagVocabulary,
  threadTagPaths,
} from "@t3tools/shared/threadTags";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadTags extends Context.Service<
  ThreadTags,
  {
    readonly vocabulary: (
      input: ThreadTagVocabularyInput,
    ) => Effect.Effect<ThreadTagVocabularyResult, ThreadTagDiscoveryError>;
    readonly query: (
      input: ThreadTagQueryInput,
    ) => Effect.Effect<ThreadTagQueryResult, ThreadTagDiscoveryError>;
  }
>()("t3/orchestration-v2/ThreadTags") {}

function paginate<T>(items: readonly T[], input: { cursor?: number; limit?: number }) {
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? 50);
  return { items: items.slice(start, end), nextCursor: end < items.length ? end : null };
}
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const read = Effect.fn("ThreadTags.read")(function* (input: {
    projectId?: ThreadTagQueryInput["projectId"];
    archived?: boolean;
  }) {
    const snapshot = yield* threads
      .getShellSnapshot({
        location: input.archived ? "archive" : "active",
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadTagDiscoveryError({ message: "Unable to access thread tags.", cause }),
        ),
      );
    return {
      snapshotSequence: snapshot.snapshotSequence,
      threads: (input.archived ? snapshot.archivedThreads : snapshot.threads).filter(
        (thread) => thread.deletedAt === null,
      ),
    };
  });
  const query = Effect.fn("ThreadTags.query")(function* (input: ThreadTagQueryInput) {
    const { threads: shells, snapshotSequence } = yield* read(input);
    const result = paginate(
      shells
        .filter((thread) => matchesThreadTag(thread.tags, input.tag, input.mode))
        .sort(
          (a, b) =>
            DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        ),
      input,
    );
    return { threads: result.items, nextCursor: result.nextCursor, snapshotSequence };
  });
  const vocabulary = Effect.fn("ThreadTags.vocabulary")(function* (
    input: ThreadTagVocabularyInput,
  ) {
    const { threads: canonical } = yield* read(
      input.uiVisibility
        ? input.archived === undefined
          ? {}
          : { archived: input.archived }
        : input,
    );
    const visibility = input.uiVisibility;
    const hidden =
      visibility === undefined
        ? new Set<string>()
        : hiddenThreadKeys(
            [
              {
                environmentId: visibility.environmentId,
                threads: canonical,
                hiddenTags: visibility.hiddenTags,
              },
            ],
            new Set(visibility.hiddenThreadKeys),
            new Set(visibility.loadedThreadKeys),
            visibility.hidingAnywhere,
          );
    const shells = canonical.filter(
      (thread) =>
        (input.projectId === undefined || thread.projectId === input.projectId) &&
        (visibility === undefined || !hidden.has(`${visibility.environmentId}\u0000${thread.id}`)),
    );
    const entries = new Map<string, { tag: string; count: number; projectCount: number }>();
    const projects = new Map<string, Set<string>>();
    const preferred = new Set<string>();
    for (const thread of shells)
      for (const tag of new Set((thread.tags ?? []).flatMap(threadTagPaths))) {
        const entry = entries.get(tag) ?? { tag, count: 0, projectCount: 0 };
        entry.count++;
        const ids = projects.get(tag) ?? new Set<string>();
        ids.add(thread.projectId);
        projects.set(tag, ids);
        entry.projectCount = ids.size;
        entries.set(tag, entry);
        if (thread.projectId === input.preferredProjectId) preferred.add(tag);
      }
    const ranked = rankThreadTagVocabulary([...entries.values()], input.query, preferred);
    const result = paginate(ranked, input);
    return {
      entries:
        visibility === undefined
          ? result.items
          : result.items.map((entry) => ({ ...entry, preferredProject: preferred.has(entry.tag) })),
      nextCursor: result.nextCursor,
    };
  });
  return ThreadTags.of({ query, vocabulary });
});
export const layer = Layer.effect(ThreadTags, make);
