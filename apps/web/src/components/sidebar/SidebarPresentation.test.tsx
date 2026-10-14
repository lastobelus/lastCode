// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { SidebarPresentation } from "./SidebarPresentation";

it("defers first mount and preserves drafts while hidden effects are released", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const subscribe = vi.fn(),
    unsubscribe = vi.fn();
  function Editor() {
    const [value, setValue] = useState("Initial");
    useEffect(() => {
      subscribe();
      return unsubscribe;
    }, []);
    return <input value={value} onChange={(event) => setValue(event.target.value)} />;
  }
  const render = (visible: boolean) =>
    act(() =>
      root.render(
        <SidebarPresentation visible={visible}>
          <Editor />
        </SidebarPresentation>,
      ),
    );
  try {
    await render(false);
    expect(container.querySelector("input")).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
    await render(true);
    const input = container.querySelector("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Unsent draft",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await render(true);
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsent draft");
    expect(subscribe).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
