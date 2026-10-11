// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { bindSidebarRailScroll } from "./sidebarRailScroll";

afterEach(() => document.body.replaceChildren());

function sidebar() {
  const inner = document.createElement("div");
  inner.dataset.slot = "sidebar-inner";
  inner.innerHTML =
    '<div data-slot="scroll-area-viewport"><div data-sidebar="content"></div></div><button></button>';
  document.body.append(inner);
  const viewport = inner.firstElementChild as HTMLElement;
  const rail = inner.lastElementChild as HTMLElement;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 600 },
  });
  viewport.style.lineHeight = "20px";
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 700 } as DOMRect);
  viewport.scrollBy = vi.fn();
  return { viewport, rail };
}

const wheel = (options: WheelEventInit = {}) =>
  new WheelEvent("wheel", { cancelable: true, deltaY: 120, clientY: 300, ...options });

it("sends wheel input on the resize strip to its own sidebar viewport and releases the binding", () => {
  const unrelated = sidebar();
  const { rail, viewport } = sidebar();
  const dispose = bindSidebarRailScroll(rail);
  const event = wheel();
  rail.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(viewport.scrollBy).toHaveBeenCalledWith({ top: 120, behavior: "instant" });
  expect(unrelated.viewport.scrollBy).not.toHaveBeenCalled();
  dispose();
  const detached = wheel();
  rail.dispatchEvent(detached);
  expect(detached.defaultPrevented).toBe(false);
  expect(viewport.scrollBy).toHaveBeenCalledOnce();
});

it("normalizes mouse line and page deltas while leaving zoom, header and non-scrollable regions alone", () => {
  const { rail, viewport } = sidebar();
  const dispose = bindSidebarRailScroll(rail);
  rail.dispatchEvent(wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE }));
  rail.dispatchEvent(wheel({ deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE }));
  expect(viewport.scrollBy).toHaveBeenNthCalledWith(1, { top: 60, behavior: "instant" });
  expect(viewport.scrollBy).toHaveBeenNthCalledWith(2, { top: -600, behavior: "instant" });
  for (const options of [{ ctrlKey: true }, { clientY: 50 }, { clientY: 700 }, { deltaY: 0 }]) {
    const event = wheel(options);
    rail.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  Object.defineProperty(viewport, "scrollHeight", { value: 600 });
  const event = wheel();
  rail.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(viewport.scrollBy).toHaveBeenCalledTimes(2);
  dispose();
});
