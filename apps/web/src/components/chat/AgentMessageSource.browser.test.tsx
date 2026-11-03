import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import { AgentMessageSource } from "./AgentMessageSource";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  threads: [] as SidebarThreadSummary[],
  readShells: vi.fn(),
}));

vi.mock("../../state/entities", () => ({
  useQuietThreadShells: () => {
    mocks.readShells();
    return mocks.threads;
  },
  useProject: () => ({ title: "Example project" }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

function setup() {
  const parent = makeThreadFixture({ id: ThreadId.make("parent"), title: "Parent thread" });
  const child = makeThreadFixture({
    id: ThreadId.make("child"),
    title: "Sending subagent",
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
    },
  });
  mocks.threads = [parent, child];
  mocks.readShells.mockClear();
  return {
    parentRef: scopeThreadRef(parent.environmentId, parent.id),
    senderRef: scopeThreadRef(child.environmentId, child.id),
  };
}

it("reveals the sender's project and ancestors on hover without subscribing closed rows", async () => {
  const { senderRef } = setup();
  await using screen = await render(
    <AgentMessageSource senderRef={senderRef} currentThreadRef={null} onOpenThread={() => {}} />,
  );
  expect(mocks.readShells).not.toHaveBeenCalled();
  await userEvent.hover(screen.getByRole("button", { name: "Open sending thread" }));
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  await vi.waitFor(() => {
    expect(tooltip.element().textContent).toContain("Example project");
    expect(tooltip.element().textContent).toContain("Parent thread");
    expect(tooltip.element().textContent).toContain("Subagent: Sending subagent");
  });
});

it("shortens the ancestor path through the current thread on keyboard focus", async () => {
  const { senderRef, parentRef } = setup();
  await using screen = await render(
    <AgentMessageSource
      senderRef={senderRef}
      currentThreadRef={parentRef}
      onOpenThread={() => {}}
    />,
  );
  await act(() => screen.getByRole("button", { name: "Open sending thread" }).element().focus());
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  await vi.waitFor(() => {
    expect(tooltip.element().textContent).toContain("Current Thread");
    expect(tooltip.element().textContent).toContain("Sending subagent");
    expect(tooltip.element().textContent).not.toContain("Parent thread");
    expect(tooltip.element().textContent).not.toContain("Example project");
  });
});

it("explains when the sending thread is unavailable", async () => {
  const { senderRef } = setup();
  mocks.threads = [];
  await using screen = await render(
    <AgentMessageSource senderRef={senderRef} currentThreadRef={null} onOpenThread={() => {}} />,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Open sending thread" }));
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Sending thread unavailable");
});
