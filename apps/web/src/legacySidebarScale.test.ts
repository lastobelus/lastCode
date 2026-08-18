import { describe, expect, it } from "vite-plus/test";

import { legacySidebarScaleStyle } from "./legacySidebarScale";

describe("legacySidebarScaleStyle", () => {
  it("leaves the stock sidebar geometry unchanged at 100%", () => {
    expect(legacySidebarScaleStyle(100)).toEqual({
      zoom: 1,
      "--legacy-sidebar-icon-zoom": 1,
    });
  });

  it("renders the reference profile at 75% while keeping icons at stock size", () => {
    const style = legacySidebarScaleStyle(75);

    expect(style.zoom).toBe(0.75);
    expect(style["--legacy-sidebar-icon-zoom"]).toBeCloseTo(4 / 3);
  });

  it("renders the minimum 50% scale", () => {
    expect(legacySidebarScaleStyle(50)).toEqual({
      zoom: 0.5,
      "--legacy-sidebar-icon-zoom": 2,
    });
  });
});
