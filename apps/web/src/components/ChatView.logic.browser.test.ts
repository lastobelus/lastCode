import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const list = document.createElement("ul");
  const row = (name: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.dataset.sidebarRow = name;
    element.textContent = name;
    list.append(element);
    return element;
  };
  const clicked = row("Clicked thread");
  const tabbed = row("Tabbed thread");
  document.body.append(list);
  using _list = { [Symbol.dispose]: () => list.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});

it("keeps keyboard focus on the conversation timeline on window return, but not a click", async () => {
  const timeline = document.createElement("div");
  timeline.className = "messages-timeline-scroll";
  timeline.tabIndex = -1;
  timeline.textContent = "Assistant reply";
  document.body.append(timeline);
  using _cleanup = { [Symbol.dispose]: () => timeline.remove() };

  await userEvent.click(timeline);
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(timeline);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);
  });
  timeline.blur();
  await userEvent.keyboard("{F6}");
  timeline.focus();
  await vi.waitFor(() =>
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false),
  );
});
