import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { attachSidebarTree, SIDEBAR_TREE_PROPS } from "../../lib/sidebarTree";
import { focusSidebarSearchResultDetails, SidebarThreadHover } from "./SidebarThreadHover";
import "../../index.css";

function Harness({
  search = false,
  disabled = false,
  onOpen = vi.fn(),
}: {
  search?: boolean;
  disabled?: boolean;
  onOpen?: (url: string) => void;
}) {
  const [query, setQuery] = useState("thread");
  return (
    <>
      <input
        aria-label="Search threads"
        role="combobox"
        aria-expanded={search}
        aria-activedescendant={search ? "hover-result" : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => focusSidebarSearchResultDetails(event)}
      />
      <ul
        {...(search ? { role: "listbox" } : SIDEBAR_TREE_PROPS)}
        ref={search ? undefined : attachSidebarTree}
        style={{ width: 220 }}
      >
        <li>
          <SidebarThreadHover
            id="hover-result"
            disabled={disabled}
            nativeButton={search}
            render={
              search ? (
                <button type="button" role="option" tabIndex={-1} />
              ) : (
                <div role="treeitem" tabIndex={-1} data-sidebar-row="thread" />
              )
            }
            content={
              <div>
                <p>Thread details</p>
                {[11, 42].map((number) => (
                  <a
                    key={number}
                    className="block"
                    href={`https://github.com/example/project/pull/${number}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(event.currentTarget.href);
                    }}
                  >
                    PR #{number}
                  </a>
                ))}
              </div>
            }
          >
            Thread row
          </SidebarThreadHover>
        </li>
        {!search ? (
          <li>
            <div role="treeitem" tabIndex={-1} data-sidebar-row="next">
              Next thread
            </div>
          </li>
        ) : null}
      </ul>
      <button>Outside</button>
    </>
  );
}

it.each([false, true])(
  "reaches PR links from the search=%s row and returns focus on Escape",
  async (search) => {
    const onOpen = vi.fn();
    await using screen = await render(<Harness search={search} onOpen={onOpen} />);
    const input = screen.getByRole("combobox");
    await userEvent.click(input);
    const row = screen.getByRole(search ? "option" : "treeitem", { name: "Thread row" });
    if (search) await userEvent.hover(row);
    await userEvent.keyboard("{Tab}");
    await expect.element(row).toHaveFocus();
    const first = page.getByRole("link", { name: "PR #11" });
    const second = page.getByRole("link", { name: "PR #42" });
    await expect.element(first).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(row).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(first).toHaveFocus();
    await userEvent.hover(screen.getByRole("button", { name: "Outside" }));
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{Tab}{Enter}");
    await expect.element(second).toHaveFocus();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("https://github.com/example/project/pull/42");
    await userEvent.keyboard("{Escape}");
    await expect.element(search ? input : row).toHaveFocus();
    await expect.element(first).not.toBeInTheDocument();
    if (search) {
      await userEvent.keyboard(" edited");
      await expect.element(input).toHaveValue("thread edited");
    } else {
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(screen.getByRole("treeitem", { name: "Next thread" })).toHaveFocus();
    }
  },
);

it("crosses the shared pointer edge immediately and releases closed popup focus guards", async () => {
  await using screen = await render(<Harness />);
  const row = screen.getByRole("treeitem", { name: "Thread row" });
  const original = row.element();
  await userEvent.hover(row);
  const details = page.getByText("Thread details", { exact: true });
  await expect.element(details).toBeVisible();
  await userEvent.hover(details);
  await expect.element(details).toBeVisible();
  await userEvent.hover(row);
  await expect.element(details).toBeVisible();
  await userEvent.hover(screen.getByRole("button", { name: "Outside" }));
  await expect.element(details).not.toBeInTheDocument();
  expect(row.element()).toBe(original);
  await act(() => (screen.getByRole("combobox").element() as HTMLElement).focus());
  await userEvent.keyboard("{Tab}");
  await expect.element(row).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("link", { name: "PR #11" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  await expect.element(details).not.toBeInTheDocument();
  await userEvent.hover(row);
  await expect.element(details).toBeVisible();
  await screen.rerender(<Harness disabled />);
  await expect.element(details).not.toBeInTheDocument();
  await screen.rerender(<Harness />);
  await expect.element(details).not.toBeInTheDocument();
  expect(row.element()).toBe(original);
});
