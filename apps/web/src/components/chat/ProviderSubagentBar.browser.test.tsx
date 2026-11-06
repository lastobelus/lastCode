import { act, render, type Screen } from "../../../test/render";
import { type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { ProviderSubagentBar } from "./ProviderSubagentBar";

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
function controls(screen: Screen) {
  const update = (props: Partial<typeof baseProps> = {}) =>
    screen.rerender(<ProviderSubagentBar {...baseProps} {...props} />);
  const button = (label: string) => {
    const result = [...screen.container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    if (!result) throw new Error(`Missing button ${label}`);
    return result;
  };
  return { update, button };
}

it("preserves focused promotion and blocks duplicate activation during a delayed request", async () => {
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { update, button } = controls(screen);
  let finish = () => {};
  const onPromote = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await update({ onPromote });
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
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { update, button } = controls(screen);
  await update({ promotion: waiting });
  button("Cancel").focus();
  await update({ promotion: { ...waiting, status: "forking" } });
  expect(document.activeElement).toBe(button("Promoting to interactive thread"));
});

it("does not steal focus from elsewhere when cancellation disappears", async () => {
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { update, button } = controls(screen);
  await update({ promotion: waiting });
  button("Cancel").focus();
  const elsewhere = document.createElement("button");
  screen.container.append(elsewhere);
  elsewhere.focus();
  await update({ promotion: { ...waiting, status: "forking" } });
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.remove();
});

it("only opens the promoted thread after the user activates its button", async () => {
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { update, button } = controls(screen);
  const onOpenPromoted = vi.fn();
  await update({ promotion: waiting, onOpenPromoted });
  const promote = button("Promoting to interactive thread");
  promote.focus();
  await update({ promotion: { ...waiting, status: "promoted" }, onOpenPromoted });
  expect(document.activeElement).toBe(promote);
  expect(onOpenPromoted).not.toHaveBeenCalled();
  await act(() => button("promoted to interactive thread").click());
  expect(onOpenPromoted).toHaveBeenCalledTimes(1);
});

it("keeps the focused control mounted when the environment disconnects", async () => {
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { update, button } = controls(screen);
  await update();
  const promote = button("Promote to interactive thread");
  promote.focus();
  await update({ onPromote: null });
  expect(button("Promote to interactive thread")).toBe(promote);
  expect(document.activeElement).toBe(promote);
  expect(promote.getAttribute("aria-disabled")).toBe("true");
});

it("clears a local error after another client advances the durable promotion", async () => {
  await using screen = await render(null);
  using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const container = screen.container;
  const { update, button } = controls(screen);
  await update({
    onPromote: async () => {
      throw new Error("Connection lost");
    },
  });
  await act(async () => button("Promote to interactive thread").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  await update({ promotion: { ...waiting, status: "promoted" }, onOpenPromoted: () => {} });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
