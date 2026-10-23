import { act, render } from "../../../test/render";
import { memo, useState } from "react";

import { expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import {
  LastCodeSidebarPresentationProvider,
  useLastCodeSidebarPresentation,
} from "./LastCodeSidebarPresentation";
const mocks = vi.hoisted(() => ({ render: vi.fn(), open: vi.fn(() => true) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => mocks.open }));
const values: Omit<ComponentProps<typeof LastCodeSidebarPresentationProvider>, "children"> = {
  projectEnvironments: {
    desktopLocalEnvironmentIds: new Set(),
    knownEnvironmentIds: new Set(),
    showLocalEnvironmentIcon: false,
  },
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

function setup() {
  vi.clearAllMocks();
}

it("keeps unrelated provider renders from invalidating consumers and retains local editing", async () => {
  setup();
  await using screen = await render(
    <LastCodeSidebarPresentationProvider {...values}>
      <Consumer />
    </LastCodeSidebarPresentationProvider>,
  );
  const container = screen.container;
  const input = container.querySelector("input")!;
  await act(() => {
    input.value = "in progress";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const renders = mocks.render.mock.calls.length;
  await screen.rerender(
    <LastCodeSidebarPresentationProvider {...values}>
      <Consumer />
    </LastCodeSidebarPresentationProvider>,
  );
  await screen.rerender(
    <LastCodeSidebarPresentationProvider {...values}>
      <Consumer />
    </LastCodeSidebarPresentationProvider>,
  );
  expect(mocks.render).toHaveBeenCalledTimes(renders);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("in progress");
});
it("refreshes bounded presentation choices without resetting consumer state", async () => {
  setup();
  await using screen = await render(
    <LastCodeSidebarPresentationProvider {...values}>
      <Consumer />
    </LastCodeSidebarPresentationProvider>,
  );
  const container = screen.container;
  const input = container.querySelector("input")!;
  await act(() => {
    input.value = "retained";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const renders = mocks.render.mock.calls.length;
  await screen.rerender(
    <LastCodeSidebarPresentationProvider
      {...{
        ...values,
        providerBadgePreferences: { ...values.providerBadgePreferences, size: 75 },
        openPullRequestsInRightPanel: false,
      }}
    >
      <Consumer />
    </LastCodeSidebarPresentationProvider>,
  );
  expect(mocks.render).toHaveBeenCalledTimes(renders + 1);
  expect(container.querySelector("span")?.textContent).toBe("75 / browser");
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("retained");
});
