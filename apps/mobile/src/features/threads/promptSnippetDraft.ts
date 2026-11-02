import type { PromptSnippet } from "@t3tools/contracts";

export interface PromptSnippetDraft {
  readonly title: string;
  readonly text: string;
  readonly originalTitle: string;
  readonly originalText: string;
}

export const hasPromptSnippetDraftChanges = (draft: PromptSnippetDraft) =>
  draft.title !== draft.originalTitle || draft.text !== draft.originalText;

export function resolvePromptSnippetLibrary(
  snippets: ReadonlyArray<PromptSnippet>,
  pendingSaves: ReadonlyArray<PromptSnippet>,
) {
  const pending = pendingSaves.filter(
    (saved) =>
      !snippets.some(
        (snippet) =>
          snippet.id === saved.id && snippet.title === saved.title && snippet.text === saved.text,
      ),
  );
  return {
    pendingSaves: pending,
    snippets: [
      ...snippets.map((snippet) => {
        const saved = pending.find((entry) => entry.id === snippet.id);
        return saved
          ? { ...snippet, title: saved.title, text: saved.text, userEdited: true as const }
          : snippet;
      }),
      ...pending.filter((saved) => !snippets.some((snippet) => snippet.id === saved.id)),
    ],
  };
}

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
