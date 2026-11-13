// Each case is one row of the behaviour table in docs/lastcode/keyboard-scrolling.md.
import { describe, expect, it, vi } from "vite-plus/test";
import { attachTimelineViewport } from "./components/chat/timelineViewport";
import * as settings from "./hooks/useSettings";
import { startLastCodeScrollKeys } from "./lastcodeScrollKeys";
import { registerCommands } from "./shortcuts/dispatcher";

const FIXTURE = `
<div style="position: fixed; inset: 0; width: 400px; height: 400px; font: 16px/20px sans-serif">
  <section data-workspace-area="sidebar" tabindex="-1" style="position: absolute; left: 0; top: 0; width: 120px; height: 300px">
    <div data-slot="sidebar-inner" style="position: relative; height: 100%">
      <input data-testid="sidebar-search" style="height: 20px; width: 100px" />
      <div data-slot="scroll-area-viewport" data-testid="sidebar" style="height: 280px; overflow-y: auto">
        <div data-sidebar="content" style="height: 2000px">
          <button data-testid="sidebar-row">Thread</button>
          <div style="height: 180px"></div>
          <div data-testid="sidebar-inner-list" style="height: 60px; overflow-y: auto"><div style="height: 120px"></div></div>
        </div>
      </div>
      <button data-sidebar="rail" data-testid="rail" style="position: absolute; right: -4px; top: 0; width: 8px; height: 100%"></button>
    </div>
  </section>
  <div style="position: absolute; left: 130px; top: 0; width: 150px; height: 300px">
    <section data-workspace-area="conversation" data-testid="conversation-area" tabindex="-1" style="height: 300px">
      <div data-testid="timeline" data-workspace-focus-default tabindex="-1" style="height: 300px; overflow-y: auto">
        <div class="chat-markdown" style="height: 3000px; line-height: 20px">Messages</div>
      </div>
    </section>
    <div data-workspace-area="composer" data-chat-composer-overlay="true" style="position: absolute; left: 0; right: 0; bottom: 0; height: 60px">
      <div contenteditable="true" role="textbox" data-testid="composer" style="height: 40px">Draft</div>
    </div>
  </div>
  <div data-slot="popover-popup" data-open style="position: absolute; left: 290px; top: 0; width: 100px; height: 100px">
    <div data-testid="card" style="height: 100px; overflow-y: auto"><div style="height: 500px"></div></div>
  </div>
  <section data-workspace-area="settings" data-testid="settings-area" tabindex="-1" style="position: absolute; left: 290px; top: 110px; width: 100px; height: 80px">
    <div data-testid="settings" style="height: 80px; overflow-y: auto"><div style="height: 400px"></div></div>
  </section>
  <section data-workspace-area="terminal" style="position: absolute; left: 290px; top: 200px; width: 100px; height: 90px">
    <div data-terminal-owner="drawer" style="height: 90px; overflow-y: auto">
      <textarea data-testid="terminal" style="height: 20px"></textarea><div style="height: 400px"></div>
    </div>
  </section>
  <div data-slot="menu-popup" data-open role="menu" style="position: absolute; left: 0; top: 310px; width: 120px; height: 40px">
    <button role="menuitem" data-testid="menu-item">Item</button>
  </div>
</div>`;

function setup() {
  const stack = new DisposableStack();
  const root = document.createElement("div");
  root.innerHTML = FIXTURE;
  document.body.append(root);
  stack.defer(() => root.remove());
  stack.defer(startLastCodeScrollKeys(document));
  const get = (testId: string) => root.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  const pointAt = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        clientX: box.left + Math.min(box.width / 2, 20),
        clientY: box.top + Math.min(box.height / 2, 40),
      }),
    );
  };
  const press = (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };
  return { get, pointAt, press, stack, [Symbol.dispose]: () => stack.dispose() };
}

describe("LastCode scroll keys", () => {
  it("scroll the pane under the pointer whatever has focus", () => {
    using dom = setup();
    const sidebar = dom.get("sidebar");
    const timeline = dom.get("timeline");
    for (const focus of [timeline, dom.get("sidebar-row"), document.body]) {
      sidebar.scrollTop = 0;
      if (focus === document.body) (document.activeElement as HTMLElement | null)?.blur();
      else focus.focus();
      dom.pointAt(sidebar);
      expect(dom.press("ArrowDown").defaultPrevented).toBe(true);
      expect(sidebar.scrollTop).toBe(40);
      expect(dom.press("PageDown").defaultPrevented).toBe(true);
      expect(sidebar.scrollTop).toBe(40 + 280 * 0.9);
      dom.press("ArrowUp");
      expect(sidebar.scrollTop).toBe(280 * 0.9);
      expect(timeline.scrollTop).toBe(0);
      expect(document.activeElement).toBe(focus);
    }
    sidebar.scrollTop = 0;
    dom.pointAt(dom.get("rail"));
    dom.press("ArrowDown");
    expect(sidebar.scrollTop).toBe(40);
  });

  it("let the composer keep its keys over its own conversation, and give them up over other panes", () => {
    using dom = setup();
    const sidebar = dom.get("sidebar");
    const timeline = dom.get("timeline");
    const card = dom.get("card");
    dom.get("composer").focus();
    dom.pointAt(timeline);
    // Caret moves, prompt recall and the composer's own page handoff stay upstream's.
    expect(dom.press("ArrowUp").defaultPrevented).toBe(false);
    expect(dom.press("PageUp").defaultPrevented).toBe(false);
    expect(timeline.scrollTop).toBe(0);
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(true);
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(sidebar.scrollTop).toBe(40 + 280 * 0.9);
    dom.pointAt(card);
    dom.press("ArrowDown");
    expect(card.scrollTop).toBe(40);
    // Focus inside the card with the pointer over nothing scrollable: the browser scrolls the card.
    card.tabIndex = -1;
    card.focus();
    dom.pointAt(dom.get("composer"));
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    dom.get("sidebar-search").focus();
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
  });

  it("park the pointer for arrow keys after any other key until the mouse moves", () => {
    using dom = setup();
    const sidebar = dom.get("sidebar");
    dom.get("composer").focus();
    dom.pointAt(sidebar);
    dom.press("a");
    dom.press("Shift");
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    expect(sidebar.scrollTop).toBe(0);
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(sidebar.scrollTop).toBe(280 * 0.9);
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(true);
    expect(sidebar.scrollTop).toBe(280 * 0.9 + 40);
  });

  it("leave keys to suggestion lists, the terminal, open menus, shortcuts and modified presses", () => {
    using dom = setup();
    const sidebar = dom.get("sidebar");
    const composer = dom.get("composer");
    composer.setAttribute("aria-activedescendant", "suggestion-1");
    composer.focus();
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    composer.removeAttribute("aria-activedescendant");
    dom.get("terminal").focus();
    dom.pointAt(sidebar);
    expect(dom.press("ArrowUp").defaultPrevented).toBe(false);
    dom.get("timeline").focus();
    dom.pointAt(dom.get("terminal"));
    expect(dom.press("PageDown").defaultPrevented).toBe(false);
    dom.get("menu-item").focus();
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    dom.get("timeline").focus();
    dom.pointAt(sidebar);
    for (const options of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ]) {
      dom.pointAt(sidebar);
      expect(dom.press("ArrowDown", options).defaultPrevented).toBe(false);
    }
    expect(sidebar.scrollTop).toBe(0);
    const command = vi.fn();
    dom.stack.defer(
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
    dom.pointAt(sidebar);
    dom.press("PageDown");
    expect(command).toHaveBeenCalledOnce();
    expect(sidebar.scrollTop).toBe(0);
  });

  it("stop at the end of the pane under the pointer instead of moving another pane", () => {
    using dom = setup();
    const sidebar = dom.get("sidebar");
    const inner = dom.get("sidebar-inner-list");
    const card = dom.get("card");
    dom.get("timeline").focus();
    inner.scrollTop = inner.scrollHeight;
    dom.pointAt(inner);
    dom.press("ArrowDown");
    expect(sidebar.scrollTop).toBe(40);
    sidebar.scrollTop = sidebar.scrollHeight;
    dom.pointAt(sidebar);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(true);
    card.scrollTop = card.scrollHeight;
    dom.pointAt(card);
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(dom.get("timeline").scrollTop).toBe(0);
  });

  it("release timeline follow and page the conversation above the composer", () => {
    using dom = setup();
    const timelineNode = dom.get("timeline");
    const timeline = attachTimelineViewport(timelineNode);
    dom.stack.defer(() => timeline.dispose());
    const navigations: unknown[] = [];
    timeline.subscribe((navigation) => navigations.push(navigation));
    const visible = 300 - 60;
    dom.get("sidebar-row").focus();
    dom.pointAt(timelineNode);
    dom.press("ArrowDown");
    expect(timelineNode.scrollTop).toBe(40);
    dom.press("PageDown");
    expect(timelineNode.scrollTop).toBe(40 + visible - 20);
    expect(navigations).toEqual([
      { source: "key", key: "ArrowDown", direction: "down" },
      { source: "key", key: "PageDown", direction: "down" },
    ]);
    const previousSettings = settings.getClientSettings();
    dom.stack.defer(() => settings.__setClientSettingsForTests(previousSettings));
    settings.__setClientSettingsForTests({ ...previousSettings, pageScrollOverlapEnabled: false });
    dom.press("PageUp");
    expect(timelineNode.scrollTop).toBe(40 - 20);
    // With focus on the timeline the browser scrolls arrows itself; only paging is replaced.
    timelineNode.focus();
    dom.pointAt(timelineNode);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(timelineNode.scrollTop).toBe(20 + visible);
  });

  it("scroll a focused workspace region's content when no pointer is known", () => {
    using dom = setup();
    const settingsNode = dom.get("settings");
    const timelineNode = dom.get("timeline");
    const timeline = attachTimelineViewport(timelineNode);
    dom.stack.defer(() => timeline.dispose());
    window.dispatchEvent(new Event("blur"));
    dom.get("settings-area").focus();
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(settingsNode.scrollTop).toBe(80 * 0.9);
    dom.press("ArrowDown");
    expect(settingsNode.scrollTop).toBe(80 * 0.9 + 40);
    dom.get("conversation-area").focus();
    dom.press("PageDown");
    expect(timelineNode.scrollTop).toBe(300 - 60 - 20);
    timelineNode.focus();
    expect(dom.press("PageDown").defaultPrevented).toBe(true);
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
    dom.get("sidebar-row").focus();
    expect(dom.press("ArrowDown").defaultPrevented).toBe(false);
  });
});
