import {
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "./components/chat/composerFocusRedirect";
import { hasCommandForKeyDown } from "./shortcuts/dispatcher";

// LastCode: arrow and page keys scroll the pane under the mouse pointer. Upstream sends them
// to the focused element only. The rules and the upstream seams they rest on are in
// docs/lastcode/keyboard-scrolling.md; change that page with this file.

export type ScrollKey = "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown";

/** A scroller that keeps state about user scrolling (the timeline's follow) or pages its own way. */
export interface ScrollKeyOwner {
  readonly beforeScroll?: (key: ScrollKey) => void;
  /** Also claims page keys while the scroller itself has focus. */
  readonly pageDistancePx?: () => number;
}

// Chromium's native arrow-key step.
const ARROW_STEP_PX = 40;
const AREA_SELECTOR = "[data-workspace-area]";
const TERMINAL_SELECTOR = "[data-terminal-owner]";
const LAYER_SELECTOR = `${TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR},[data-slot="popover-popup"],[data-slot="preview-card-popup"],[role="dialog"]`;
// Focus that consumes keys wherever the pointer is: open suggestion lists, the terminal and
// shortcut recorders.
const FOCUS_OWNS_KEYS_SELECTOR = `[aria-activedescendant],[role="combobox"][aria-expanded="true"],[data-keybinding-capture],${TERMINAL_SELECTOR}`;
// Focus that consumes arrows while the pointer stays over its own pane.
const PANE_OWNS_KEYS_SELECTOR = `${TYPE_TO_FOCUS_EDITABLE_SELECTOR},[role="listbox"],[role="menu"],[role="menubar"],[role="tree"],[role="grid"],[role="tablist"],[role="radiogroup"],[role="slider"],[role="spinbutton"]`;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"]);

const owners = new WeakMap<Element, ScrollKeyOwner>();

export function registerScrollKeyOwner(element: HTMLElement, owner: ScrollKeyOwner): () => void {
  owners.set(element, owner);
  return () => {
    if (owners.get(element) === owner) owners.delete(element);
  };
}

function readScrollKey(event: KeyboardEvent): ScrollKey | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "PageUp" ||
    event.key === "PageDown"
    ? event.key
    : null;
}

// A pane counts even while its content fits, so a key over it stops there instead of falling
// through to the focused pane.
function isScrollContainer(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || element.clientHeight === 0) return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
}

function isScroller(element: Element): element is HTMLElement {
  return isScrollContainer(element) && element.scrollHeight > element.clientHeight + 1;
}

function canScroll(element: HTMLElement, direction: -1 | 1) {
  return direction < 0
    ? element.scrollTop > 0.5
    : element.scrollTop < element.scrollHeight - element.clientHeight - 0.5;
}

function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Scrollers from the hovered element outward, stopping where the wheel would: a floating layer's
 * edge or a scroller that contains its overscroll. */
function scrollersFrom(start: Element): HTMLElement[] {
  // The sidebar's resize rail overlaps the list edge but sits outside its scroll ancestry.
  const rail = start.closest("[data-sidebar='rail']");
  const origin =
    (rail &&
      Array.from(
        rail.closest("[data-slot='sidebar-inner']")?.querySelectorAll("[data-sidebar='content']") ??
          [],
        (content) => content.closest("[data-slot='scroll-area-viewport']"),
      ).find((viewport) => viewport && viewport.getBoundingClientRect().height > 0)) ||
    start;
  const scrollers: HTMLElement[] = [];
  for (let element: Element | null = origin; element; element = parentAcrossShadow(element)) {
    if (isScrollContainer(element)) {
      scrollers.push(element);
      if (getComputedStyle(element).overscrollBehaviorY !== "auto") break;
    }
    if (element.matches(LAYER_SELECTOR)) break;
  }
  return scrollers;
}

/**
 * The pane a key belongs to: its workspace area (areas inside a dialog stay separate), else its
 * floating layer. The composer writes into the conversation beside it.
 */
function paneOf(element: Element): Element | null {
  const layer = element.closest(LAYER_SELECTOR);
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
  if (layer && !(area && layer.contains(area))) return layer;
  if (area?.dataset.workspaceArea !== "composer") return area;
  const conversation = '[data-workspace-area="conversation"]';
  return area.parentElement?.closest(`:has(${conversation})`)?.querySelector(conversation) ?? area;
}

/** Whether a key the focused element would receive should go to the scroller under the pointer. */
function pointerTakesKey(focus: Element | null, scroller: HTMLElement): boolean {
  if (!focus || focus === focus.ownerDocument.body || focus === focus.ownerDocument.documentElement)
    return true;
  const layer = focus.closest(LAYER_SELECTOR);
  if (layer && !layer.contains(scroller)) return false;
  if (focus.closest(FOCUS_OWNS_KEYS_SELECTOR)) return false;
  if (focus.closest(PANE_OWNS_KEYS_SELECTOR)) return paneOf(focus) !== paneOf(scroller);
  return true;
}

/** The scroller a focused workspace region stands for; the region itself cannot scroll. */
function areaScroller(area: HTMLElement): HTMLElement | null {
  const preferred = area.querySelector<HTMLElement>("[data-workspace-focus-default]");
  const candidates = preferred
    ? [preferred, ...area.querySelectorAll("*")]
    : area.querySelectorAll("*");
  for (const element of candidates) {
    if (
      isScroller(element) &&
      element.closest(AREA_SELECTOR) === area &&
      !element.closest(TERMINAL_SELECTOR) &&
      element.checkVisibility({ visibilityProperty: true })
    )
      return element;
  }
  return null;
}

function scrollByKey(scroller: HTMLElement, key: ScrollKey) {
  const owner = owners.get(scroller);
  owner?.beforeScroll?.(key);
  const page = key === "PageUp" || key === "PageDown";
  const distance = page
    ? (owner?.pageDistancePx?.() ?? scroller.clientHeight * 0.9)
    : ARROW_STEP_PX;
  scroller.scrollBy({
    top: (key === "PageUp" || key === "ArrowUp" ? -1 : 1) * distance,
    behavior: "instant",
  });
}

export function startLastCodeScrollKeys(doc: Document = document): () => void {
  const view = doc.defaultView;
  let pointer: { x: number; y: number } | null = null;
  // Like macOS hiding the cursor while you type, any other key parks the pointer for arrow keys
  // until it moves, so caret and list arrows keep working with the mouse resting elsewhere.
  let parked = false;
  const forget = () => {
    pointer = null;
  };
  const onPointerMove = (event: PointerEvent) => {
    pointer = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null;
    parked = false;
  };
  // A touch or pen tap moves no mouse; the remembered mouse position no longer points anywhere.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") forget();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const key = readScrollKey(event);
    if (!key) {
      if (!MODIFIER_KEYS.has(event.key)) parked = true;
      return;
    }
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      hasCommandForKeyDown(event)
    )
      return;
    const focus = event.composedPath()[0];
    const focused = focus instanceof Element ? focus : null;
    const direction = key === "PageUp" || key === "ArrowUp" ? -1 : 1;
    const page = key === "PageUp" || key === "PageDown";

    let chain: HTMLElement[];
    if (pointer && (page || !parked)) {
      const hovered = doc.elementFromPoint(pointer.x, pointer.y);
      if (!hovered || hovered.closest(TERMINAL_SELECTOR)) return;
      chain = scrollersFrom(hovered);
      if (chain.length === 0 || !pointerTakesKey(focused, chain[0]!)) return;
      // The browser already scrolls the focused scroller; only an owner's own paging replaces it.
      const native = chain.find(isScroller);
      if (native && focused === native && !(page && owners.get(native)?.pageDistancePx)) return;
    } else if (focused instanceof HTMLElement && focused.matches(AREA_SELECTOR)) {
      const scroller = areaScroller(focused);
      if (!scroller) return;
      chain = [scroller];
    } else if (focused instanceof HTMLElement && page && owners.get(focused)?.pageDistancePx) {
      chain = [focused];
    } else {
      return;
    }

    const target = chain.find((scroller) => canScroll(scroller, direction));
    // With nothing to scroll here, focus inside this pane keeps the key (row and section arrows).
    if (!target && focused && chain.some((scroller) => scroller.contains(focused))) return;
    // At the end of every scroller under the pointer the key stops; it must not move another pane.
    event.preventDefault();
    event.stopPropagation();
    if (target) scrollByKey(target, key);
  };
  doc.addEventListener("pointermove", onPointerMove, { passive: true });
  doc.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
  doc.documentElement.addEventListener("pointerleave", forget);
  doc.addEventListener("keydown", onKeyDown, true);
  view?.addEventListener("blur", forget);
  return () => {
    doc.removeEventListener("pointermove", onPointerMove);
    doc.removeEventListener("pointerdown", onPointerDown, { capture: true });
    doc.documentElement.removeEventListener("pointerleave", forget);
    doc.removeEventListener("keydown", onKeyDown, true);
    view?.removeEventListener("blur", forget);
  };
}
