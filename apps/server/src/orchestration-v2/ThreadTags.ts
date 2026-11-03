import {
  type CommandId,
  type ThreadTagQueryInput,
  type ThreadTagQueryResult,
  type ThreadTagSetInput,
  type ThreadTagVocabularyInput,
  type ThreadTagVocabularyResult,
  ThreadTagDiscoveryError,
} from "@t3tools/contracts";
import {
  matchesThreadTag,
  rankThreadTagVocabulary,
  threadTagPaths,
} from "@t3tools/shared/threadTags";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
    readonly set: (
      input: ThreadTagSetInput & { readonly commandId: CommandId },
    ) => Effect.Effect<{ readonly sequence: number }, ThreadTagDiscoveryError>;
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
    return (input.archived ? snapshot.archivedThreads : snapshot.threads).filter(
      (thread) => thread.deletedAt === null,
    );
  });
  const query = Effect.fn("ThreadTags.query")(function* (input: ThreadTagQueryInput) {
    const shells = yield* read(input);
    const result = paginate(
      shells
        .filter((thread) => matchesThreadTag(thread.tags, input.tag, input.mode))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      input,
    );
    return { threads: result.items, nextCursor: result.nextCursor };
  });
  const vocabulary = Effect.fn("ThreadTags.vocabulary")(function* (
    input: ThreadTagVocabularyInput,
  ) {
    const shells = yield* read(input);
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
    const result = paginate(
      rankThreadTagVocabulary([...entries.values()], input.query, preferred),
      input,
    );
    return { entries: result.items, nextCursor: result.nextCursor };
  });
  const set = Effect.fn("ThreadTags.set")(function* (
    input: ThreadTagSetInput & { readonly commandId: CommandId },
  ) {
    const result = yield* threads
      .dispatch({ type: "thread.tag.set", ...input })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadTagDiscoveryError({ message: "Unable to access thread tags.", cause }),
        ),
      );
    return { sequence: result.sequence };
  });
  return ThreadTags.of({ query, vocabulary, set });
});
export const layer = Layer.effect(ThreadTags, make);
