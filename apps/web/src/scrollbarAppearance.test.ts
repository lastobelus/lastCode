import { describe, expect, it, vi } from "vite-plus/test";

import { applyScrollbarAppearance } from "./scrollbarAppearance";

describe("applyScrollbarAppearance", () => {
  it("sets the thumb, margin, and total hit-lane sizes", () => {
    const { root, setProperty, toggleAttribute } = makeRoot();

    applyScrollbarAppearance(root, { enabled: true, width: 9, margin: 5 });

    expect(toggleAttribute).toHaveBeenCalledWith("data-larger-scrollbars", true);
    expect(setProperty).toHaveBeenCalledWith("--app-scrollbar-width", "9px");
    expect(setProperty).toHaveBeenCalledWith("--app-scrollbar-margin", "5px");
    expect(setProperty).toHaveBeenCalledWith("--app-scrollbar-lane-width", "14px");
    expect(setProperty).toHaveBeenCalledWith("--app-native-scrollbar-margin", "5px");
    expect(setProperty).toHaveBeenCalledWith("--app-scrollbar-thumb-inset", "0px");
  });

  it("restores the stylesheet defaults when disabled", () => {
    const { root, removeProperty, toggleAttribute } = makeRoot();

    applyScrollbarAppearance(root, { enabled: false, width: 12, margin: 6 });

    expect(toggleAttribute).toHaveBeenCalledWith("data-larger-scrollbars", false);
    expect(removeProperty).toHaveBeenCalledWith("--app-scrollbar-width");
    expect(removeProperty).toHaveBeenCalledWith("--app-scrollbar-margin");
    expect(removeProperty).toHaveBeenCalledWith("--app-scrollbar-lane-width");
    expect(removeProperty).toHaveBeenCalledWith("--app-native-scrollbar-margin");
    expect(removeProperty).toHaveBeenCalledWith("--app-scrollbar-thumb-inset");
  });
});

function makeRoot() {
  const setProperty = vi.fn();
  const removeProperty = vi.fn();
  const toggleAttribute = vi.fn();
  return {
    root: {
      style: { setProperty, removeProperty },
      toggleAttribute,
    } as unknown as HTMLElement,
    setProperty,
    removeProperty,
    toggleAttribute,
  };
}
