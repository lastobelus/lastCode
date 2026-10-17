// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { ProviderSubagentBar } from "./ProviderSubagentBar";

let root: Root;
let container: HTMLDivElement;
const baseProps: ComponentProps<typeof ProviderSubagentBar> = {
  provider: null,
  showInstanceBadge: false,
  modelLabel: "Model",
  effortLabel: null,
  status: null,
  onOpenParent: null,
  promotion: null,
  promotionAvailable: true,
  onPromote: async () => {},
  onCancelPromotion: async () => {},
  onOpenPromoted: null,
};
const waiting = {
  createdBy: "user" as const,
  creationSource: "web" as const,
  requestId: CommandId.make("promotion"),
  targetThreadId: ThreadId.make("interactive"),
  status: "waiting" as const,
  error: null,
  requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
};
const render = async (props: Partial<typeof baseProps> = {}) => {
  await act(() => root.render(<ProviderSubagentBar {...baseProps} {...props} />));
};
const button = (label: string) => {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves focused promotion and blocks duplicate activation during a delayed request", async () => {
  let finish = () => {};
  const onPromote = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render({ onPromote });
  const promote = button("Promote to interactive thread");
  promote.focus();
  await act(() => promote.click());
  expect(document.activeElement).toBe(promote);
  expect(promote.getAttribute("aria-disabled")).toBe("true");
  await act(() => promote.click());
  expect(onPromote).toHaveBeenCalledTimes(1);
  await act(() => finish());
  expect(document.activeElement).toBe(promote);
});

it("moves focus from a removed Cancel to the surviving promotion action", async () => {
  await render({ promotion: waiting });
  button("Cancel").focus();
  await render({ promotion: { ...waiting, status: "forking" } });
  expect(document.activeElement).toBe(button("Promoting to interactive thread"));
});

it("does not steal focus from elsewhere when cancellation disappears", async () => {
  await render({ promotion: waiting });
  button("Cancel").focus();
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  await render({ promotion: { ...waiting, status: "forking" } });
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});

it("only opens the promoted thread after the user activates its button", async () => {
  const onOpenPromoted = vi.fn();
  await render({ promotion: waiting, onOpenPromoted });
  const promote = button("Promoting to interactive thread");
  promote.focus();
  await render({ promotion: { ...waiting, status: "promoted" }, onOpenPromoted });
  expect(document.activeElement).toBe(promote);
  expect(onOpenPromoted).not.toHaveBeenCalled();
  await act(() => button("promoted to interactive thread").click());
  expect(onOpenPromoted).toHaveBeenCalledTimes(1);
});

it("keeps the focused control mounted when the environment disconnects", async () => {
  await render();
  const promote = button("Promote to interactive thread");
  promote.focus();
  await render({ onPromote: null });
  expect(button("Promote to interactive thread")).toBe(promote);
  expect(document.activeElement).toBe(promote);
  expect(promote.getAttribute("aria-disabled")).toBe("true");
});

it("clears a local error after another client advances the durable promotion", async () => {
  await render({
    onPromote: async () => {
      throw new Error("Connection lost");
    },
  });
  await act(async () => button("Promote to interactive thread").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  await render({ promotion: { ...waiting, status: "promoted" }, onOpenPromoted: () => {} });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
