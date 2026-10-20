import { describe, expect, it } from "vite-plus/test";

import { resolveProjectFaviconBorderRadius } from "./projectFaviconAppearance";

describe("project favicon appearance", () => {
  it("defaults to the original square canvas and retains the prior rounded radius on opt-in", () => {
    expect(resolveProjectFaviconBorderRadius(20, false)).toBe(0);
    expect(resolveProjectFaviconBorderRadius(20, true)).toBe(3.2);
  });
});
