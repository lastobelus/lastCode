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
const LAYER_SELECTOR = `${TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR},[data-slot="popover-popup"],[data-slot="preview-card-popup"],[role="dialog"]`;
// Focus that consumes arrows wherever the pointer is: open suggestion lists and the terminal.
const FOCUS_OWNS_KEYS_SELECTOR =
  '[aria-activedescendant],[role="combobox"][aria-expanded="true"],[data-terminal-owner]';
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

function isScroller(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || element.scrollHeight <= element.clientHeight + 1)
    return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
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

/** Scrollers from the hovered element outward, stopping at a floating layer's edge. */
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
    if (isScroller(element)) scrollers.push(element);
    if (element.matches(LAYER_SELECTOR)) break;
  }
  return scrollers;
}

/** The pane a key belongs to. The composer writes into the conversation beside it. */
function paneOf(element: Element): Element | null {
  const layer = element.closest(LAYER_SELECTOR);
  if (layer) return layer;
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
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
      if (!hovered || hovered.closest("[data-terminal-owner]")) return;
      chain = scrollersFrom(hovered);
      if (chain.length === 0 || !pointerTakesKey(focused, chain[0]!)) return;
      // The browser already scrolls the focused scroller; only an owner's own paging replaces it.
      if (focused === chain[0] && !(page && owners.get(chain[0])?.pageDistancePx)) return;
    } else if (focused instanceof HTMLElement && focused.matches(AREA_SELECTOR)) {
      const scroller = areaScroller(focused);
      if (!scroller) return;
      chain = [scroller];
    } else if (focused instanceof HTMLElement && page && owners.get(focused)?.pageDistancePx) {
      chain = [focused];
    } else {
      return;
    }

    // At the end of every scroller under the pointer the key stops; it must not move another pane.
    event.preventDefault();
    event.stopPropagation();
    const target = chain.find((scroller) => canScroll(scroller, direction));
    if (target) scrollByKey(target, key);
  };
  doc.addEventListener("pointermove", onPointerMove, { passive: true });
  doc.documentElement.addEventListener("pointerleave", forget);
  doc.addEventListener("keydown", onKeyDown, true);
  view?.addEventListener("blur", forget);
  return () => {
    doc.removeEventListener("pointermove", onPointerMove);
    doc.documentElement.removeEventListener("pointerleave", forget);
    doc.removeEventListener("keydown", onKeyDown, true);
    view?.removeEventListener("blur", forget);
  };
}
