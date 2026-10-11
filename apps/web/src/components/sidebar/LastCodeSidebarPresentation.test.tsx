// @vitest-environment happy-dom
import { act, memo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import {
  LastCodeSidebarPresentationProvider,
  useLastCodeSidebarPresentation,
} from "./LastCodeSidebarPresentation";
const mocks = vi.hoisted(() => ({ render: vi.fn(), open: vi.fn(() => true) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => mocks.open }));
const values: Omit<ComponentProps<typeof LastCodeSidebarPresentationProvider>, "children"> = {
  providerEntriesByEnvironmentId: new Map(),
  environmentIconColors: {},
  providerBadgePreferences: { enabled: false, size: 50, transparency: 0 },
  openPullRequestsInRightPanel: true,
};
const Consumer = memo(function Consumer() {
  const presentation = useLastCodeSidebarPresentation();
  const [draft, setDraft] = useState("");
  mocks.render();
  return (
    <>
      <input
        aria-label="Draft"
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <span>
        {presentation.providerBadgePreferences.size} /{" "}
        {presentation.openPullRequestsInRightPanel ? "panel" : "browser"}
      </span>
    </>
  );
});
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() =>
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  }),
);
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function render(props = values) {
  await act(() =>
    root.render(
      <LastCodeSidebarPresentationProvider {...props}>
        <Consumer />
      </LastCodeSidebarPresentationProvider>,
    ),
  );
}
it("keeps unrelated provider renders from invalidating consumers and retains local editing", async () => {
  await render();
  const input = container.querySelector("input")!;
  await act(() => {
    input.value = "in progress";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const renders = mocks.render.mock.calls.length;
  await render();
  await render();
  expect(mocks.render).toHaveBeenCalledTimes(renders);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("in progress");
});
it("refreshes bounded presentation choices without resetting consumer state", async () => {
  await render();
  const input = container.querySelector("input")!;
  await act(() => {
    input.value = "retained";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const renders = mocks.render.mock.calls.length;
  await render({
    ...values,
    providerBadgePreferences: { ...values.providerBadgePreferences, size: 75 },
    openPullRequestsInRightPanel: false,
  });
  expect(mocks.render).toHaveBeenCalledTimes(renders + 1);
  expect(container.querySelector("span")?.textContent).toBe("75 / browser");
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("retained");
});
