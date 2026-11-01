import type { PromptSnippet } from "@t3tools/contracts";

export interface PromptSnippetDraft {
  readonly title: string;
  readonly text: string;
  readonly originalTitle: string;
  readonly originalText: string;
}

export const hasPromptSnippetDraftChanges = (draft: PromptSnippetDraft) =>
  draft.title !== draft.originalTitle || draft.text !== draft.originalText;

export function resolvePromptSnippetDraft(
  snippet: Pick<PromptSnippet, "title" | "text"> | undefined,
  draft?: PromptSnippetDraft,
): PromptSnippetDraft {
  if (draft && hasPromptSnippetDraftChanges(draft)) return draft;
  return {
    title: snippet?.title ?? "",
    text: snippet?.text ?? "",
    originalTitle: snippet?.title ?? "",
    originalText: snippet?.text ?? "",
  };
}
