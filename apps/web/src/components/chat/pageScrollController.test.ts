import { describe, expect, test, vi } from "vite-plus/test";

import { createPageScrollController, getTimelinePageScrollKey } from "./pageScrollController";

describe("page scroll helpers", () => {
  const composerPageScrollEvent = (
    overrides: Partial<Parameters<typeof getTimelinePageScrollKey>[0]> = {},
  ) => ({
    altKey: false,
    clientHeight: 200,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key: "PageDown",
    keyCode: 34,
    metaKey: false,
    scrollHeight: 200,
    scrollTop: 0,
    shiftKey: false,
    ...overrides,
  });

  test("leaves page keys to IME composition", () => {
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ isComposing: true }))).toBeNull();
    expect(getTimelinePageScrollKey(composerPageScrollEvent({ keyCode: 229 }))).toBeNull();
  });

  test("leaves page keys to an overflowing composer until it reaches the boundary", () => {
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 0 })),
    ).toBeNull();
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 400,
        }),
      ),
    ).toBeNull();

    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 400 })),
    ).toBe("PageDown");
  });

  test("hands off page keys within a fractional pixel of the composer boundary", () => {
    expect(
      getTimelinePageScrollKey(
        composerPageScrollEvent({
          key: "PageUp",
          keyCode: 33,
          scrollHeight: 600,
          scrollTop: 0.5,
        }),
      ),
    ).toBe("PageUp");
    expect(
      getTimelinePageScrollKey(composerPageScrollEvent({ scrollHeight: 600, scrollTop: 399.5 })),
    ).toBe("PageDown");
  });

  test("stops an in-flight page when its viewport is removed or replaced", () => {
    const original = {
      clientHeight: 300,
      scrollHeight: 2000,
      scrollTop: 1700,
      getBoundingClientRect: () => ({ height: 300 }),
    };
    let current: typeof original | null = original;
    const frames: FrameRequestCallback[] = [];
    const clearTimeout = vi.fn();
    const controller = createPageScrollController({
      getContainer: () => current,
      getPageScrollDistancePx: () => 264,
      env: {
        now: () => 0,
        requestAnimationFrame: (callback) => frames.push(callback),
        cancelAnimationFrame: () => {},
        setTimeout: () => 1,
        clearTimeout,
        prefersReducedMotion: () => false,
      },
    });
    controller.handleKeyDown("PageUp");
    current = null;
    frames[0]!(150);
    expect(original.scrollTop).toBe(1700);
    expect(clearTimeout).toHaveBeenCalledWith(1);
    controller.dispose();
  });
});
