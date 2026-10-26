import { describe, expect, it } from "vite-plus/test";

import { lastcodeSidebarScaleStyle } from "./lastcodeSidebarScale";

describe("lastcodeSidebarScaleStyle", () => {
  it("leaves the stock sidebar geometry unchanged at 100%", () => {
    expect(lastcodeSidebarScaleStyle(100)).toEqual({
      zoom: 1,
      "--lastcode-sidebar-content-zoom": 1,
    });
  });

  it("renders the reference profile at 75% while keeping selected content at stock size", () => {
    const style = lastcodeSidebarScaleStyle(75);

    expect(style.zoom).toBe(0.75);
    expect(style["--lastcode-sidebar-content-zoom"]).toBeCloseTo(4 / 3);
  });

  it("renders the minimum 50% scale", () => {
    expect(lastcodeSidebarScaleStyle(50)).toEqual({
      zoom: 0.5,
      "--lastcode-sidebar-content-zoom": 2,
    });
  });
});
