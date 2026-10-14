import { describe, expect, it } from "vite-plus/test";

import { resolveDialogBackdropStyle } from "./dialog-styles";

describe("dialog backdrop interaction states", () => {
  it("stops intercepting pointer input while the dialog finishes closing", () => {
    expect(resolveDialogBackdropStyle(false, { pointerEvents: "auto" })).toMatchObject({
      pointerEvents: "none",
    });
  });

  it("preserves caller styles while the dialog is open", () => {
    const style = { cursor: "wait" } as const;
    expect(resolveDialogBackdropStyle(true, style)).toBe(style);
  });
});
