import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ThreadTag } from "./threadTags.ts";

export const THREAD_TAG_RPC_METHODS = {
  vocabulary: "lastcode.tags.vocabulary",
  query: "lastcode.tags.query",
} as const;
const page = {
  projectId: Schema.optionalKey(ProjectId),
  archived: Schema.optionalKey(Schema.Boolean),
  cursor: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};
export const ThreadTagVocabularyInput = Schema.Struct({
  ...page,
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  preferredProjectId: Schema.optionalKey(ProjectId),
});
export type ThreadTagVocabularyInput = typeof ThreadTagVocabularyInput.Type;
export const ThreadTagVocabularyEntry = Schema.Struct({
  tag: Schema.String,
  count: NonNegativeInt,
  projectCount: NonNegativeInt,
});
export type ThreadTagVocabularyEntry = typeof ThreadTagVocabularyEntry.Type;
export const ThreadTagVocabularyResult = Schema.Struct({
  entries: Schema.Array(ThreadTagVocabularyEntry),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ThreadTagVocabularyResult = typeof ThreadTagVocabularyResult.Type;
export const ThreadTagQueryInput = Schema.Struct({
  ...page,
  tag: ThreadTag,
  mode: Schema.optionalKey(Schema.Literals(["exact", "subtree"])),
});
export type ThreadTagQueryInput = typeof ThreadTagQueryInput.Type;
export const ThreadTagQueryResult = Schema.Struct({
  threads: Schema.Array(OrchestrationV2ThreadShell),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ThreadTagQueryResult = typeof ThreadTagQueryResult.Type;
export const ThreadTagSetInput = Schema.Struct({
  threadId: ThreadId,
  tag: ThreadTag,
  tagged: Schema.Boolean,
});
export type ThreadTagSetInput = typeof ThreadTagSetInput.Type;
export class ThreadTagDiscoveryError extends Schema.TaggedError<ThreadTagDiscoveryError>()(
  "ThreadTagDiscoveryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {}
