import "~/index.css";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { PromptSnippet } from "@t3tools/contracts";

import { render } from "../../../test/render";
import { PromptSnippetsPicker } from "./PromptSnippetsDialog";

const snippets: PromptSnippet[] = [
  {
    id: "review",
    title: "Review changes",
    text: "Review the changes and fix real findings.",
    useCount: 0,
    lastUsedAt: null,
    queryUses: [],
  },
  {
    id: "merge",
    title: "Merge when ready",
    text: "Merge after the checks and reviews pass.",
    useCount: 2,
    lastUsedAt: null,
    queryUses: [{ query: "rv", count: 3 }],
  },
];

function Picker(props: {
  onSelect: (snippet: PromptSnippet, query: string) => void;
  onSubmit: () => void;
  onReturnFocus: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      {open ? (
        <PromptSnippetsPicker
          snippets={snippets}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          loading={false}
          discovering={false}
          error={null}
          onClose={() => setOpen(false)}
          onReturnFocus={props.onReturnFocus}
          onSelect={(snippet, query) => {
            props.onSelect(snippet, query);
            setOpen(false);
          }}
        />
      ) : null}
    </form>
  );
}

it("uses learned abbreviations for keyboard selection without submitting the composer", async () => {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  const onReturnFocus = vi.fn();
  // router: false because this picker only inserts into its owning composer.
  await using _screen = await render(
    <Picker onSelect={onSelect} onSubmit={onSubmit} onReturnFocus={onReturnFocus} />,
    {
      router: false,
    },
  );
  await expect.element(page.getByRole("combobox", { name: "Search common prompts" })).toHaveFocus();
  await userEvent.keyboard("rv{Enter}");
  expect(onSelect).toHaveBeenCalledWith(snippets[1], "rv");
  expect(onSubmit).not.toHaveBeenCalled();
  // The insertion handler owns the pending editor update and its caret restoration.
  expect(onReturnFocus).not.toHaveBeenCalled();
});

it("keeps the selected prompt and unsaved text when switching modes, then inserts the saved edit", async () => {
  const onSelect = vi.fn();
  const onSave = vi.fn(async (input: { snippetId?: string; title: string; text: string }) => ({
    ...snippets[0]!,
    ...input,
    id: input.snippetId!,
    userEdited: true as const,
  }));
  // router: false because this feature-owned modal has no routes.
  await using _screen = await render(
    <PromptSnippetsPicker
      snippets={snippets}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      loading={false}
      discovering={false}
      error={null}
      onClose={vi.fn()}
      onReturnFocus={vi.fn()}
      onSelect={onSelect}
      onSave={onSave}
    />,
    { router: false },
  );
  await userEvent.keyboard("{ArrowDown}");
  await page.getByRole("button", { name: "Edit prompts", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Prompt title" }))
    .toHaveValue("Review changes");
  await page.getByRole("textbox", { name: "Prompt text" }).fill("review; don't merge");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Search prompts", exact: true }).click();
  await page.getByRole("button", { name: "Edit prompts", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Prompt text" }))
    .toHaveValue("review; don't merge\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave).toHaveBeenCalledWith({
    snippetId: "review",
    title: "Review changes",
    text: "review; don't merge\n",
  });
  await page.getByRole("button", { name: "Search prompts", exact: true }).click();
  await page.getByRole("combobox", { name: "Search common prompts" }).fill("review");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ id: "review", text: "review; don't merge\n" }),
    "review",
  );
});

it("retains failed saves and asks before discarding edits on close", async () => {
  const onClose = vi.fn();
  const onSave = vi.fn(async () => null);
  // router: false because this feature-owned modal has no routes.
  await using _screen = await render(
    <PromptSnippetsPicker
      snippets={snippets}
      initialMode="edit"
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      loading={false}
      discovering={false}
      error={null}
      onClose={onClose}
      onReturnFocus={vi.fn()}
      onSelect={vi.fn()}
      onSave={onSave}
    />,
    { router: false },
  );
  await page.getByRole("textbox", { name: "Prompt text" }).fill("pr/babysit/merge");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  await expect
    .element(page.getByRole("textbox", { name: "Prompt text" }))
    .toHaveValue("pr/babysit/merge");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Prompt text" }))
    .toHaveValue("pr/babysit/merge");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  expect(onClose).toHaveBeenCalledOnce();
});
