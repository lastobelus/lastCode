import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    createHandle: () => ({}),
    Root: "div",
    Portal: "div",
    Trigger: "button",
    Close: "button",
    Backdrop: ({ forceRender: _forceRender, style, ...props }: Record<string, unknown>) => (
      <div
        {...props}
        style={
          typeof style === "function" ? style({ open: false, transitionStatus: "ending" }) : style
        }
      />
    ),
    Viewport: "div",
    Popup: "div",
    Title: "h2",
    Description: "p",
  },
}));

import { DialogBackdrop } from "./dialog";

describe("DialogBackdrop", () => {
  it("does not intercept input when Base UI keeps it mounted while closing", () => {
    const markup = renderToStaticMarkup(<DialogBackdrop style={{ pointerEvents: "auto" }} />);

    expect(markup).toContain('style="pointer-events:none"');
  });
});
