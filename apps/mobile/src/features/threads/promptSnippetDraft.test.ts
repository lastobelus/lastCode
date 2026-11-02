import { expect, it } from "vite-plus/test";
import type { PromptSnippet } from "@t3tools/contracts";
import {
  hasPromptSnippetDraftChanges,
  resolvePromptSnippetDraft,
  resolvePromptSnippetLibrary,
} from "./promptSnippetDraft";

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

it("retains save results through a stale list, then retires them when acknowledged", () => {
  const original: PromptSnippet = {
    id: "review",
    title: "Review",
    text: "Old instructions.",
    useCount: 4,
    lastUsedAt: null,
    queryUses: [{ query: "rv", count: 2 }],
  };
  const saved: PromptSnippet = { ...original, text: "Saved instructions.", userEdited: true };
  const pending = resolvePromptSnippetLibrary([{ ...original, useCount: 5 }], [saved]);
  expect(pending.snippets[0]?.text).toBe(saved.text);
  expect(pending.snippets[0]?.useCount).toBe(5);
  const nextEdit = {
    ...resolvePromptSnippetDraft(pending.snippets[0]),
    title: "Review latest changes",
  };
  expect(nextEdit.text).toBe(saved.text);

  const acknowledged = resolvePromptSnippetLibrary(
    [{ ...saved, useCount: 6 }],
    pending.pendingSaves,
  );
  expect(acknowledged.pendingSaves).toEqual([]);
  expect(acknowledged.snippets[0]?.useCount).toBe(6);
  expect(resolvePromptSnippetDraft(acknowledged.snippets[0], nextEdit)).toEqual(nextEdit);
  const updated = { ...saved, text: "Another client's instructions." };
  expect(resolvePromptSnippetLibrary([updated], acknowledged.pendingSaves).snippets).toEqual([
    updated,
  ]);

  const created = resolvePromptSnippetLibrary([], [saved]);
  expect(created.snippets).toEqual([saved]);
  const createdAcknowledged = resolvePromptSnippetLibrary([saved], created.pendingSaves);
  expect(createdAcknowledged.pendingSaves).toEqual([]);
  expect(resolvePromptSnippetLibrary([], createdAcknowledged.pendingSaves).snippets).toEqual([]);
});
