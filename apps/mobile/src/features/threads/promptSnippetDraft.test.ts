import { expect, it } from "vite-plus/test";
import { hasPromptSnippetDraftChanges, resolvePromptSnippetDraft } from "./promptSnippetDraft";

it("follows refreshed wording after edits are reverted, while retaining unsaved changes", () => {
  const original = { title: "Review", text: "Review without merging." };
  let draft = { ...resolvePromptSnippetDraft(original), text: "My unsaved instructions." };
  draft = { ...resolvePromptSnippetDraft(original, draft), text: original.text };
  expect(hasPromptSnippetDraftChanges(draft)).toBe(false);

  const refreshed = { ...original, text: "Review the latest changes and report findings." };
  expect(resolvePromptSnippetDraft(refreshed, draft)).toEqual({
    ...refreshed,
    originalTitle: refreshed.title,
    originalText: refreshed.text,
  });
  draft = { ...resolvePromptSnippetDraft(refreshed, draft), title: "Review latest changes" };
  expect(draft.text).toBe(refreshed.text);
  expect(hasPromptSnippetDraftChanges(draft)).toBe(true);
  expect(
    resolvePromptSnippetDraft({ ...refreshed, text: "Another client's edit." }, draft),
  ).toEqual(draft);
});
