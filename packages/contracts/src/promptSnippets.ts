import * as Schema from "effect/Schema";

export const PromptSnippet = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  text: Schema.String,
  useCount: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.String),
  queryUses: Schema.Array(Schema.Struct({ query: Schema.String, count: Schema.Number })),
});
export type PromptSnippet = typeof PromptSnippet.Type;
export const PromptSnippetsState = Schema.Struct({
  snippets: Schema.Array(PromptSnippet),
  lastDiscoveryAt: Schema.NullOr(Schema.String),
  discovering: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type PromptSnippetsState = typeof PromptSnippetsState.Type;
export const PromptSnippetUseInput = Schema.Struct({
  snippetId: Schema.String,
  query: Schema.String,
});
export class PromptSnippetsError extends Schema.TaggedError<PromptSnippetsError>()(
  "PromptSnippetsError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prompt snippets ${this.operation} failed.`;
  }
}

export const PromptSnippetDismissInput = Schema.Struct({ snippetId: Schema.String });
