// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { bindSidebarPageScroll } from "./sidebarPageScroll";

const originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
});

function sidebar() {
  const inner = document.createElement("div");
  inner.dataset.slot = "sidebar-inner";
  inner.innerHTML =
    '<header></header><section><div data-slot="scroll-area-viewport"><div data-sidebar="content"></div></div></section><button data-sidebar="rail"></button>';
  document.body.append(inner);
  const scrollArea = inner.querySelector("section")!;
  const viewport = scrollArea.firstElementChild as HTMLElement;
  const rail = inner.lastElementChild as HTMLElement;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 2000, configurable: true },
    clientHeight: { value: 600 },
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 700 } as DOMRect);
  viewport.scrollBy = (options: ScrollToOptions | number, y?: number) => {
    const delta = typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
    viewport.scrollTop = Math.max(0, Math.min(1400, viewport.scrollTop + delta));
  };
  const dispose = bindSidebarPageScroll(scrollArea)!;
  disposers.push(dispose);
  return { viewport, rail, header: inner.firstElementChild!, dispose };
}

const hover = (target: Element | null, y = 300, pointerType = "mouse") => {
  Object.defineProperty(document, "elementFromPoint", { value: () => target, configurable: true });
  const event = new MouseEvent("pointermove", { bubbles: true, clientX: 150, clientY: y });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  document.dispatchEvent(event);
};
const key = (target: Element, key = "PageDown", options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
};
const composer = () => {
  const editor = document.createElement("textarea");
  document.body.append(editor);
  editor.focus();
  return editor;
};

it("pages the hovered list in both directions without changing composer focus or routing to the composer", () => {
  const { viewport } = sidebar();
  const editor = composer();
  const composerKey = vi.fn();
  editor.addEventListener("keydown", composerKey);
  viewport.scrollTop = 200;
  hover(viewport);
  expect(key(editor).defaultPrevented).toBe(true);
  expect(viewport.scrollTop).toBe(740);
  expect(key(editor, "PageUp").defaultPrevented).toBe(true);
  expect(viewport.scrollTop).toBe(200);
  expect(document.activeElement).toBe(editor);
  expect(composerKey).not.toHaveBeenCalled();
});

it("targets only the hovered sidebar, including its resize edge, and consumes boundary pages", () => {
  const first = sidebar();
  const second = sidebar();
  const editor = composer();
  hover(second.rail);
  key(editor);
  expect(first.viewport.scrollTop).toBe(0);
  expect(second.viewport.scrollTop).toBe(540);
  second.viewport.scrollTop = 1400;
  expect(key(editor).defaultPrevented).toBe(true);
  expect(second.viewport.scrollTop).toBe(1400);
  second.viewport.scrollTop = 0;
  expect(key(editor, "PageUp").defaultPrevented).toBe(true);
  expect(second.viewport.scrollTop).toBe(0);
});

it("leaves keys outside the list, under an overlay, in header/footer positions, or without mouse hover alone", () => {
  const { viewport, rail, header } = sidebar();
  const editor = composer();
  expect(key(editor).defaultPrevented).toBe(false);
  for (const [target, y, pointerType] of [
    [editor, 300, "mouse"],
    [header, 50, "mouse"],
    [rail, 700, "mouse"],
    [null, 300, "mouse"],
    [viewport, 300, "touch"],
  ] as const) {
    hover(target, y, pointerType);
    expect(key(editor).defaultPrevented).toBe(false);
  }
  expect(viewport.scrollTop).toBe(0);
});

it("preserves modified keys, composition, sidebar editing, and focused floating controls", () => {
  const { viewport } = sidebar();
  const editor = composer();
  hover(viewport);
  for (const options of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ]) {
    expect(key(editor, "PageDown", options).defaultPrevented).toBe(false);
  }
  expect(key(editor, "ArrowDown").defaultPrevented).toBe(false);
  const rename = document.createElement("input");
  viewport.append(rename);
  rename.focus();
  expect(key(rename).defaultPrevented).toBe(false);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const item = document.createElement("button");
  menu.append(item);
  document.body.append(menu);
  item.focus();
  expect(key(item).defaultPrevented).toBe(false);
  expect(viewport.scrollTop).toBe(0);
});

it("preserves fixed-header search and focused controls managing a separate results listbox", () => {
  const { viewport, header } = sidebar();
  const search = document.createElement("input");
  header.append(search);
  search.focus();
  hover(viewport);
  const searchKeys: string[] = [];
  search.addEventListener("keydown", (event) => searchKeys.push(event.key));
  expect(key(search).defaultPrevented).toBe(false);
  expect(key(search, "PageUp").defaultPrevented).toBe(false);
  expect(searchKeys).toEqual(["PageDown", "PageUp"]);
  expect(document.activeElement).toBe(search);

  const control = document.createElement("input");
  control.setAttribute("role", "combobox");
  control.setAttribute("aria-expanded", "true");
  control.setAttribute("aria-controls", "results");
  control.setAttribute("aria-activedescendant", "result-1");
  const results = document.createElement("div");
  results.id = "results";
  results.setAttribute("role", "listbox");
  document.body.append(control, results);
  control.focus();
  expect(key(control).defaultPrevented).toBe(false);
  expect(viewport.scrollTop).toBe(0);
  expect(document.activeElement).toBe(control);
});

it("releases stale pointer state and the binding, and leaves a list with no overflow alone", () => {
  const { viewport, dispose } = sidebar();
  const editor = composer();
  hover(viewport);
  window.dispatchEvent(new Event("blur"));
  expect(key(editor).defaultPrevented).toBe(false);
  hover(viewport);
  document.dispatchEvent(new Event("pointerleave"));
  expect(key(editor).defaultPrevented).toBe(false);
  hover(viewport);
  Object.defineProperty(viewport, "scrollHeight", { value: 600 });
  expect(key(editor).defaultPrevented).toBe(false);
  Object.defineProperty(viewport, "scrollHeight", { value: 2000 });
  dispose();
  expect(key(editor).defaultPrevented).toBe(false);
  expect(viewport.scrollTop).toBe(0);
});
