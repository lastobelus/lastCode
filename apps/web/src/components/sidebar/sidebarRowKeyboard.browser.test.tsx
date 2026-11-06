import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ThreadAnnotationNavigationTrigger } from "../thread-annotation/ThreadAnnotation";
import { PopoverCreateHandle } from "../ui/popover";
import { activateSidebarRowFromKeyboard } from "./sidebarRowKeyboard";

vi.mock("../ChatMarkdown", () => ({ default: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function withRow(
  annotationActive: boolean,
  check: (row: HTMLElement, navigate: ReturnType<typeof vi.fn>) => void,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn();
  try {
    await act(() => {
      root.render(
        <ThreadAnnotationNavigationTrigger
          annotationActive={annotationActive}
          handle={PopoverCreateHandle()}
          id="sidebar-keyboard-row"
          render={<div />}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => activateSidebarRowFromKeyboard(event, navigate)}
        >
          Thread
          <button type="button">Archive</button>
          <button type="button">Confirm archive</button>
          <a href="https://github.example/project/pull/42">Pull request</a>
        </ThreadAnnotationNavigationTrigger>,
      );
    });
    await act(() =>
      check(container.querySelector<HTMLElement>("#sidebar-keyboard-row")!, navigate),
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

describe.each([true, false])("sidebar row keyboard with annotation=%s", (annotationActive) => {
  it.each(["Enter", " "])("activates the focused row once for %s", async (key) => {
    await withRow(annotationActive, (row, navigate) => {
      row.focus();
      const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      row.dispatchEvent(down);
      row.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      expect(down.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["Archive", "Enter"],
    ["Archive", " "],
    ["Confirm archive", "Enter"],
    ["Confirm archive", " "],
    ["Pull request", "Enter"],
  ])("preserves the focused %s control's %s action", async (label, key) => {
    await withRow(annotationActive, (row, navigate) => {
      const control = Array.from(row.querySelectorAll<HTMLElement>("button,a")).find(
        (element) => element.textContent === label,
      )!;
      control.focus();
      const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
      control.dispatchEvent(down);
      control.dispatchEvent(up);
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(control);
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
