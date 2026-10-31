import { act, render } from "../../../test/render";
import { useEffect, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { SidebarPresentation } from "./SidebarPresentation";

it("unmounts the pre-hydration placeholder rather than retaining its hidden effects and state", async () => {
  await using screen = await render(null);
  const container = screen.container;
  const update = (visible: boolean, retain: boolean) =>
    screen.rerender(
      <SidebarPresentation visible={visible} retain={retain}>
        <input defaultValue="Placeholder" />
      </SidebarPresentation>,
    );
  await update(true, false);
  const first = container.querySelector("input")!;
  first.value = "Placeholder draft";
  await update(false, true);
  expect(container.querySelector("input")).toBeNull();
  await update(true, true);
  expect(container.querySelector("input")).not.toBe(first);
  expect(container.querySelector("input")?.value).toBe("Placeholder");
});

it("defers first mount and preserves drafts while hidden effects are released", async () => {
  await using screen = await render(null);
  const container = screen.container;
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
  const update = (visible: boolean) =>
    screen.rerender(
      <SidebarPresentation visible={visible}>
        <Editor />
      </SidebarPresentation>,
    );
  await update(false);
  expect(container.querySelector("input")).toBeNull();
  expect(subscribe).not.toHaveBeenCalled();
  await update(true);
  const input = container.querySelector("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Unsent draft",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await update(false);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await update(true);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("Unsent draft");
  expect(subscribe).toHaveBeenCalledTimes(2);
});
