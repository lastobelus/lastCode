import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import appCss from "~/index.css?inline";
import { createWorkspaceFocusController } from "./workspaceFocus";
import { registerCommands } from "../shortcuts/dispatcher";
import * as settings from "../hooks/useSettings";
import { attachTimelineViewport } from "../components/chat/timelineViewport";

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = createWorkspaceFocusController(document);
  const area = (name: string, order: number, parent: HTMLElement = root) => {
    const element = document.createElement("section");
    element.dataset.workspaceArea = name;
    element.dataset.workspaceOrder = String(order);
    element.tabIndex = -1;
    const button = document.createElement("button");
    button.textContent = name;
    element.append(button);
    parent.append(element);
    return { element, button };
  };
  const append = (html: string) => {
    root.insertAdjacentHTML("beforeend", html);
    return root.lastElementChild as HTMLElement;
  };
  return {
    area,
    append,
    controller,
    [Symbol.dispose]() {
      controller.dispose();
      root.remove();
    },
  };
}

describe("workspace area focus", () => {
  it("pages the visible conversation above the composer with one line of overlap", () => {
    using fixture = setup();
    const area = fixture.area("conversation", 1);
    area.button.remove();
    const viewport = document.createElement("div");
    viewport.style.cssText = "height: 200px; overflow-y: auto";
    viewport.innerHTML =
      '<div class="chat-markdown" style="height: 2000px; line-height: 20px">Content\n\nwith blank lines</div>';
    area.element.append(viewport);
    const timeline = attachTimelineViewport(viewport);
    using cleanup = new DisposableStack();
    cleanup.defer(() => timeline.dispose());
    const navigations: unknown[] = [];
    timeline.subscribe((navigation) =>
      navigations.push({ navigation, scrollTop: viewport.scrollTop }),
    );
    const composer = fixture.append('<div data-chat-composer-overlay="true"></div>');
    composer.style.cssText = `position: fixed; top: ${viewport.getBoundingClientRect().top + 140}px; height: 60px`;
    area.element.focus();
    viewport.scrollTop = 300;
    const page = (key: string, target = area.element) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    page("PageDown");
    expect(viewport.scrollTop).toBe(420);
    expect(navigations).toEqual([
      { navigation: { source: "key", key: "PageDown", direction: "down" }, scrollTop: 300 },
    ]);
    page("PageUp");
    expect(viewport.scrollTop).toBe(300);
    composer.style.top = `${viewport.getBoundingClientRect().top + 100}px`;
    composer.style.height = "100px";
    page("PageDown");
    expect(viewport.scrollTop).toBe(380);
    expect(document.activeElement).toBe(area.element);
    const previousSettings = settings.getClientSettings();
    using stack = new DisposableStack();
    stack.defer(() => settings.__setClientSettingsForTests(previousSettings));
    settings.__setClientSettingsForTests({
      ...previousSettings,
      pageScrollOverlapEnabled: false,
    });
    page("PageDown");
    expect(viewport.scrollTop).toBe(480);
    page("PageUp");
    expect(viewport.scrollTop).toBe(380);
    viewport.tabIndex = -1;
    viewport.focus();
    page("PageDown", viewport);
    expect(viewport.scrollTop).toBe(480);
    page("PageUp", viewport);
    expect(viewport.scrollTop).toBe(380);
    expect(document.activeElement).toBe(viewport);
  });

  it("runs configured page-key shortcuts before the scrolling fallback", () => {
    using fixture = setup();
    const area = fixture.area("conversation", 1);
    const viewport = document.createElement("div");
    viewport.style.cssText = "height: 100px; overflow-y: auto";
    viewport.innerHTML = '<div style="height: 1000px">Scrollable content</div>';
    area.element.append(viewport);
    const timeline = attachTimelineViewport(viewport);
    area.element.focus();
    const command = vi.fn();
    using stack = new DisposableStack();
    stack.defer(() => timeline.dispose());
    const navigate = vi.fn();
    timeline.subscribe(navigate);
    stack.defer(
      registerCommands(
        { "chat.new": command },
        {
          keybindings: () => [
            {
              command: "chat.new",
              shortcut: {
                key: "pagedown",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
          ],
        },
      ),
    );
    area.element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "PageDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(command).toHaveBeenCalledOnce();
    expect(viewport.scrollTop).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("pages the scrolling content when the surrounding workspace region has focus", () => {
    using fixture = setup();
    using cleanup = new DisposableStack();
    for (const name of ["conversation", "sidebar", "panel"]) {
      const area = fixture.area(name, 1);
      const viewport = document.createElement("div");
      viewport.style.cssText = "height: 100px; overflow-y: auto; line-height: 10px";
      viewport.innerHTML = '<div style="height: 1000px">Scrollable content</div>';
      area.element.append(viewport);
      if (name === "conversation") {
        const timeline = attachTimelineViewport(viewport);
        cleanup.defer(() => timeline.dispose());
      }
      area.element.focus();
      const page = (key: string) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        area.element.dispatchEvent(event);
        return event;
      };
      expect(page("PageDown").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(90);
      expect(page("PageDown").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(180);
      expect(page("PageUp").defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(90);
      expect(document.activeElement).toBe(area.element);
    }
  });

  it("leaves focused controls, modified keys, and other workspace areas alone", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const nested = fixture.area("nested", 4, panel.element);
    const viewport = document.createElement("div");
    viewport.style.cssText = "height: 100px; overflow-y: auto";
    viewport.innerHTML = '<div style="height: 1000px">Scrollable content</div>';
    nested.element.append(viewport);
    const page = (target: HTMLElement, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "PageDown",
        bubbles: true,
        cancelable: true,
        ...options,
      });
      target.dispatchEvent(event);
      return event;
    };
    panel.element.focus();
    expect(page(panel.element).defaultPrevented).toBe(false);
    nested.button.focus();
    expect(page(nested.button).defaultPrevented).toBe(false);
    nested.element.focus();
    for (const options of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ])
      expect(page(nested.element, options).defaultPrevented).toBe(false);
    expect(viewport.scrollTop).toBe(0);
    expect(page(nested.element).defaultPrevented).toBe(true);
    expect(viewport.scrollTop).toBe(90);
    fixture.controller.dispose();
    expect(page(nested.element).defaultPrevented).toBe(false);
    expect(viewport.scrollTop).toBe(90);
  });

  it("cycles in workspace order in both directions, independent of DOM order", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    sidebar.button.focus();
    fixture.controller.move(1);
    // The conversation is a region; it takes focus itself rather than its first button.
    expect(document.activeElement).toBe(conversation.element);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(panel.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(sidebar.button);
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(panel.button);
    const timeline = document.createElement("div");
    timeline.tabIndex = -1;
    timeline.dataset.workspaceFocusDefault = "";
    timeline.style.height = "200px";
    conversation.element.append(timeline);
    composer.button.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(timeline);
  });

  it("skips hidden, inert, and maximized-away areas", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 3);
    const terminal = fixture.area("terminal", 4);
    conversation.element.dataset.chatColumnMaximizedAway = "true";
    composer.element.hidden = true;
    panel.element.dataset.workspaceUnavailable = "true";
    terminal.element.inert = true;
    sidebar.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });

  it("restores the last focused control and falls back when it is removed", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    const remembered = document.createElement("button");
    remembered.textContent = "remembered";
    composer.element.append(remembered);
    remembered.focus();
    fixture.controller.move(-1);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(remembered);
    fixture.controller.move(-1);
    remembered.remove();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
  });

  it("keeps focus inside a dialog or an open popup", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("panel", 3);
    const dialog = fixture.append('<div role="dialog" tabindex="-1">Confirm</div>');
    dialog.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    dialog.remove();

    const popup = fixture.append(
      '<div role="listbox" data-slot="select-popup"><button role="option">Choice</button></div>',
    );
    const choice = popup.querySelector("button")!;
    choice.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(choice);
  });

  it("keeps moving while a non-modal notification is visible", () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const panel = fixture.area("panel", 4);
    fixture.append(
      '<div data-slot="toast-viewport"><div role="dialog" aria-modal="false" tabindex="0">Update available</div></div>',
    );
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
  });

  it("moves only between the areas of an open Settings modal", () => {
    using fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("composer", 2);
    const modal = fixture.append('<div role="dialog" data-app-modal=""></div>');
    const nav = fixture.area("settings-nav", 0, modal);
    const content = fixture.area("settings", 1, modal);
    nav.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(nav.button);
  });

  it("keeps moving while a shortcut recorder is on the page but not focused", () => {
    using fixture = setup();
    const nav = fixture.area("settings-nav", 0);
    const content = fixture.area("settings", 1);
    fixture.append('<button data-keybinding-capture="">Record shortcut</button>');
    nav.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
  });

  it("brings a restored control back into view inside its own list", () => {
    using fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const list = document.createElement("div");
    list.style.cssText = "height: 50px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    const row = document.createElement("button");
    row.textContent = "Last thread";
    list.append(spacer, row);
    sidebar.element.append(list);
    const composer = fixture.area("composer", 2);
    row.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    list.scrollTop = 0;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(row);
    expect(list.scrollTop).toBeGreaterThan(0);
  });

  it("reveals a restored control through nested scrolling lists", () => {
    using fixture = setup();
    const settings = fixture.area("settings", 1);
    const page = document.createElement("div");
    page.style.cssText = "height: 80px; overflow-y: auto";
    const inner = document.createElement("div");
    inner.style.cssText = "height: 60px; overflow-y: auto";
    const field = document.createElement("button");
    field.textContent = "Provider field";
    inner.append(Object.assign(document.createElement("div"), { style: "height: 200px" }), field);
    page.append(inner, Object.assign(document.createElement("div"), { style: "height: 400px" }));
    settings.element.append(page);
    const nav = fixture.area("settings-nav", 0);
    field.focus();
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(nav.button);
    inner.scrollTop = 0;
    page.scrollTop = 300;
    fixture.controller.move(1);
    expect(document.activeElement).toBe(field);
    const box = page.getBoundingClientRect();
    const rect = field.getBoundingClientRect();
    expect(rect.bottom > box.top && rect.top < box.bottom).toBe(true);
  });

  it("does not scroll the conversation to an old control", () => {
    using fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const timeline = document.createElement("div");
    timeline.style.cssText = "height: 50px; overflow-y: auto";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    timeline.append(copy, Object.assign(document.createElement("div"), { style: "height: 400px" }));
    conversation.element.append(timeline);
    const composer = fixture.area("composer", 2);
    copy.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    // Live follow moved the timeline to the newest output.
    timeline.scrollTop = 300;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    expect(timeline.scrollTop).toBe(300);
  });

  it.each([
    ["panel", "panel", "removed"],
    ["conversation", "composer", "removed"],
    ["conversation", "composer", "disabled"],
  ])("recovers focus from a %s control to the %s when %s", async (source, destination, change) => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const area = fixture.area(source, 3);
    const control = document.createElement("button");
    control.id = "pending-request";
    control.textContent = "Submit";
    area.element.append(control);
    control.focus();
    if (change === "disabled") control.disabled = true;
    else control.remove();
    const expected = destination === "composer" ? composer.button : area.button;
    await vi.waitFor(() => expect(document.activeElement).toBe(expected));
  });

  it("falls back to the main content when the whole area disappears", async () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const details = fixture.area("details", 3);
    details.button.focus();
    details.element.hidden = true;
    await vi.waitFor(() => expect(document.activeElement).toBe(composer.button));
  });

  it("keeps focus on the control a panel tab switch came from", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const content = document.createElement("div");
    content.setAttribute("data-right-panel-surface-content", "");
    const row = (name: string) => {
      const button = document.createElement("button");
      button.textContent = name;
      content.append(button);
      return button;
    };
    const earlierRow = row("reference-analysis.md");
    const clickedRow = row("print-guide.md");
    panel.element.append(content);
    panel.element.dataset.workspaceFocusKey = "panel:file:print-guide.md";
    earlierRow.focus();
    panel.element.dataset.workspaceFocusKey = "panel:file:reference-analysis.md";
    clickedRow.focus();
    panel.element.dataset.workspaceFocusKey = "panel:file:print-guide.md";
    expect(fixture.controller.focus("panel")).toBe(true);
    expect(document.activeElement).toBe(clickedRow);
  });

  it("focuses a side chat's message input when the panel opens on it", () => {
    using fixture = setup();
    const panel = fixture.area("panel", 3);
    const content = document.createElement("div");
    content.setAttribute("data-right-panel-surface-content", "");
    const bringBack = document.createElement("button");
    bringBack.textContent = "Bring back";
    content.append(bringBack);
    panel.element.append(content);
    fixture.area("conversation", 1, content);
    const composer = fixture.area("composer", 2, content);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    composer.element.append(editor);
    expect(fixture.controller.focus("panel")).toBe(true);
    expect(document.activeElement).toBe(editor);
    // F6 from the message input moves on to the panel's own controls.
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(bringBack);
  });

  it("waits for a requested area to mount", async () => {
    using fixture = setup();
    fixture.area("composer", 2);
    fixture.controller.request({ area: "pull-requests" });
    const list = fixture.area("pull-requests", 1);
    await vi.waitFor(() => expect(document.activeElement).toBe(list.button));
  });

  it("keeps focus on a control that React remounted elsewhere", async () => {
    using fixture = setup();
    fixture.area("composer", 2);
    const header = fixture.append("<header></header>");
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-label", "Toggle right panel");
    header.append(toggle);
    toggle.focus();
    const moved = toggle.cloneNode() as HTMLButtonElement;
    toggle.remove();
    header.append(moved);
    await vi.waitFor(() => expect(document.activeElement).toBe(moved));
  });

  it("keeps moving while a hover popup without focus is open", () => {
    using fixture = setup();
    const composer = fixture.area("composer", 2);
    const terminal = fixture.area("terminal", 4);
    fixture.append('<div data-slot="popover-popup">New split terminal</div>');
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(terminal.button);
  });

  it("rings an area reached with F6, but not a clicked one after a bare key press", async () => {
    using fixture = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    const sidebar = fixture.area("sidebar", 0);
    const home = fixture.append(
      '<main data-workspace-area="home" data-workspace-order="1" tabindex="-1" style="height: 200px"></main>',
    );
    const outline = () => getComputedStyle(home).outlineStyle;

    await userEvent.click(home);
    expect(document.activeElement).toBe(home);
    expect(outline()).toBe("none");
    // A window switch can deliver a lone modifier key without moving focus.
    await userEvent.keyboard("{Shift}");
    expect(outline(), "a clicked area shows the focus ring after a bare key press").toBe("none");
    // Window activation refocuses the element that had focus, with nothing focused in between.
    home.blur();
    home.focus();
    expect(outline(), "a clicked area rings when the window regains focus").toBe("none");

    await userEvent.keyboard("{F6}");
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(sidebar.button);
    await userEvent.keyboard("{F6}");
    fixture.controller.move(1);
    expect(document.activeElement).toBe(home);
    expect(outline()).toBe("solid");

    // A dialog opened from the keyboard returns focus to the area when it closes.
    await userEvent.keyboard("{Enter}");
    sidebar.button.focus();
    await userEvent.keyboard("{Escape}");
    home.focus();
    expect(outline(), "an area loses its ring when keyboard focus returns to it").toBe("solid");

    await userEvent.click(home);
    expect(outline(), "clicking the ringed area removes its ring").toBe("none");

    // With no other area visible, F6 lands on the area that already has focus.
    sidebar.element.hidden = true;
    await userEvent.keyboard("{F6}");
    fixture.controller.move(1);
    expect(document.activeElement).toBe(home);
    expect(outline(), "F6 onto the only, already focused area shows no ring").toBe("solid");
  });
});
