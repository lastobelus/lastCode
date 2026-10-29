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
