import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createWorkspaceFocusController } from "../lib/workspaceFocus";
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

it("refocuses the composer on window return from a clicked area after a bare key press", async () => {
  const controller = createWorkspaceFocusController(document);
  const root = document.createElement("div");
  root.innerHTML =
    '<nav data-workspace-area="sidebar" data-workspace-order="0" tabindex="-1"><button>Thread</button></nav>' +
    '<section data-workspace-area="conversation" data-workspace-order="1" tabindex="-1" style="height: 200px"></section>';
  document.body.append(root);
  using _root = {
    [Symbol.dispose]: () => {
      controller.dispose();
      root.remove();
    },
  };
  const conversation = root.querySelector("section")!;

  await userEvent.click(conversation);
  expect(document.activeElement).toBe(conversation);
  // A window switch can deliver a lone modifier key without moving focus.
  await userEvent.keyboard("{Shift}");
  expect(
    shouldRefocusComposerOnWindowFocus(document.activeElement),
    "a clicked area counts as reached from the keyboard after a bare key press",
  ).toBe(true);

  await userEvent.keyboard("{F6}");
  controller.move(-1);
  await userEvent.keyboard("{F6}");
  controller.move(1);
  expect(document.activeElement).toBe(conversation);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});

it("keeps keyboard focus on the conversation timeline on window return, but not a click", async () => {
  const timeline = document.createElement("div");
  timeline.className = "messages-timeline-scroll";
  timeline.dataset.workspaceFocusDefault = "";
  timeline.tabIndex = -1;
  timeline.textContent = "Assistant reply";
  const controller = createWorkspaceFocusController(document);
  const area = document.createElement("section");
  area.dataset.workspaceArea = "conversation";
  area.append(timeline);
  document.body.append(area);
  using _cleanup = {
    [Symbol.dispose]: () => {
      controller.dispose();
      area.remove();
    },
  };

  await userEvent.click(timeline);
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(timeline);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);
  });
  await userEvent.keyboard("{Shift}");
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);
  timeline.blur();
  await userEvent.keyboard("{F6}");
  controller.focus("conversation");
  await vi.waitFor(() =>
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false),
  );
});
