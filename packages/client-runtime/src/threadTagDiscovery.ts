import {
  THREAD_TAG_RPC_METHODS,
  ThreadTagDiscoveryError,
  type ThreadTagVocabularyInput,
  type ThreadTagVocabularyEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { request } from "./rpc/index.ts";

export const loadThreadTagVocabulary = Effect.fn("ThreadTags.loadVocabulary")(function* (
  input: ThreadTagVocabularyInput,
) {
  const entries: ThreadTagVocabularyEntry[] = [];
  let cursor = 0;
  while (true) {
    const page = yield* request(THREAD_TAG_RPC_METHODS.vocabulary, {
      ...input,
      cursor,
      limit: 100,
    });
    entries.push(...page.entries);
    if (page.nextCursor === null) return { entries };
    if (page.nextCursor <= cursor)
      return yield* new ThreadTagDiscoveryError({
        message: "Could not load tags.",
        cause: "non-advancing vocabulary cursor",
      });
    cursor = page.nextCursor;
  }
});
