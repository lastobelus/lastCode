// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { shouldClearThreadSelectionOnMouseDown } from "./components/Sidebar.logic";
let selected: boolean;
const clearOnOutside = (event: MouseEvent) => {
  if (
    shouldClearThreadSelectionOnMouseDown(event.target instanceof HTMLElement ? event.target : null)
  )
    selected = false;
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((x) => x.textContent === label)!;
beforeEach(() => {
  selected = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  window.addEventListener("mousedown", clearOnOutside);
});
afterEach(() => {
  dismissContextMenu();
  window.removeEventListener("mousedown", clearOnOutside);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
describe("detached menu press ownership", () => {
  it.each(["label", "svg"] as const)(
    "preserves selection before the %s leaf click and resolves the intended action",
    async (target) => {
      const result = showContextMenuFallback([
        { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
      ]);
      const action = button("Mark unread");
      const node = action.querySelector(target === "svg" ? "svg" : "span:last-child")!;
      expect(node).not.toBeNull();
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(selected).toBe(true);
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect(result).resolves.toBe("mark-unread");
      expect(selected).toBe(true);
    },
  );
  it("preserves selection through nested submenu activation and keyboard-generated leaf click", async () => {
    const result = showContextMenuFallback([
      {
        id: "nested",
        label: "Nested",
        children: [{ id: "mark-read", label: "Mark read", icon: "mail-open" }],
      },
    ]);
    button("Nested").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button("Nested").click();
    const leaf = button("Mark read");
    expect(document.activeElement).toBe(leaf);
    leaf.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(selected).toBe(true);
    // A native button's keyboard default action generates a detail=0 click.
    leaf.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await expect(result).resolves.toBe("mark-read");
    expect(selected).toBe(true);
  });
  it("keeps Escape cancellation selection, while outside pointer/press dismisses and clears it", async () => {
    const canceled = showContextMenuFallback([{ id: "read", label: "Mark read" }]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(canceled).resolves.toBeNull();
    expect(selected).toBe(true);
    const outside = showContextMenuFallback([{ id: "read", label: "Mark read" }]);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await expect(outside).resolves.toBeNull();
    expect(selected).toBe(false);
  });
});
