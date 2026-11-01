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

it("starts with the caret word and owns numbered shortcuts while open", async () => {
  const onSelect = vi.fn();
  const onGlobalShortcut = vi.fn();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  // router: false because the modal must consume the chord before global thread navigation.
  await using _screen = await render(
    <PromptSnippetsPicker
      snippets={snippets}
      initialQuery="rv"
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      loading={false}
      discovering={false}
      error={null}
      onClose={vi.fn()}
      onReturnFocus={vi.fn()}
      onSelect={onSelect}
    />,
    { router: false },
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey && /^[1-9]$/u.test(event.key)) onGlobalShortcut();
  };
  window.addEventListener("keydown", onKeyDown);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", onKeyDown),
  };
  await expect
    .element(page.getByRole("combobox", { name: "Search common prompts" }))
    .toHaveValue("rv");
  await userEvent.keyboard("{Meta>}9{/Meta}");
  expect(onSelect).not.toHaveBeenCalled();
  await userEvent.keyboard("{Meta>}1{/Meta}");
  expect(onSelect).toHaveBeenCalledWith(snippets[1], "rv");
  expect(onGlobalShortcut).not.toHaveBeenCalled();
});

it("keeps the selected prompt and unsaved text when switching modes, then inserts the saved edit", async () => {
  const onSelect = vi.fn();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const onSave = vi.fn(async (input: { snippetId?: string; title: string; text: string }) => ({
    ...snippets[0]!,
    ...input,
    id: input.snippetId!,
    userEdited: true as const,
  }));
  const props = {
    snippets,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    loading: false,
    discovering: false,
    error: null,
    onClose: vi.fn(),
    onReturnFocus: vi.fn(),
    onSelect,
    onSave,
  };
  // router: false because this feature-owned modal has no routes.
  await using screen = await render(<PromptSnippetsPicker {...props} />, { router: false });
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
  await userEvent.keyboard("{Meta>}1{/Meta}");
  await expect
    .element(page.getByRole("textbox", { name: "Prompt title" }))
    .toHaveValue("Merge when ready");
  expect(onSelect).not.toHaveBeenCalled();
  await userEvent.keyboard("{Meta>}2{/Meta}");
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

  const saved = { ...snippets[0]!, text: "review; don't merge\n", userEdited: true as const };
  await screen.rerender(<PromptSnippetsPicker {...props} snippets={[saved, snippets[1]!]} />);
  await page.getByRole("button", { name: "Edit prompts", exact: true }).click();
  const remote = { ...saved, text: "Review the updated instructions from another client." };
  await screen.rerender(<PromptSnippetsPicker {...props} snippets={[remote, snippets[1]!]} />);
  await expect.element(page.getByRole("textbox", { name: "Prompt text" })).toHaveValue(remote.text);

  await page.getByRole("textbox", { name: "Prompt text" }).fill("My unsaved review instructions.");
  const updated = { ...remote, text: "Review again using the latest saved instructions." };
  await screen.rerender(<PromptSnippetsPicker {...props} snippets={[updated, snippets[1]!]} />);
  await expect
    .element(page.getByRole("textbox", { name: "Prompt text" }))
    .toHaveValue("My unsaved review instructions.");
  await page.getByRole("textbox", { name: "Prompt text" }).fill(remote.text);
  await expect
    .element(page.getByRole("textbox", { name: "Prompt text" }))
    .toHaveValue(updated.text);
  await page.getByRole("button", { name: "Search prompts", exact: true }).click();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith(updated, "review");

  await screen.rerender(<PromptSnippetsPicker {...props} snippets={[snippets[1]!]} />);
  await expect
    .element(page.getByRole("option", { name: updated.text, exact: true }))
    .not.toBeInTheDocument();
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
