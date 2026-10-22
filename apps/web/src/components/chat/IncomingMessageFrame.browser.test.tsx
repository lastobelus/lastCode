import { act, render as renderUi, stubGlobal } from "../../../test/render";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import { IncomingMessageFrame } from "./IncomingMessageFrame";
import "~/index.css";

describe("incoming message interaction", () => {
  async function setup() {
    await using stack = new AsyncDisposableStack();
    stack.defer(() => {
      vi.restoreAllMocks();
    });
    let textWidth = 640;
    let availableWidth = 320;
    let remeasure: (() => void) | undefined;
    stack.use(
      stubGlobal(
        "ResizeObserver",
        class {
          callback: (entries: readonly ResizeObserverEntry[]) => void;
          constructor(callback: (entries: readonly ResizeObserverEntry[]) => void) {
            this.callback = callback;
          }
          observe(element: Element) {
            if (
              element.tagName === "SPAN" &&
              element.closest("[data-incoming-message-placeholder]")
            ) {
              remeasure = () =>
                this.callback([
                  {
                    target: element,
                    contentRect: element.getBoundingClientRect(),
                    borderBoxSize: [],
                    contentBoxSize: [],
                    devicePixelContentBoxSize: [],
                  },
                ]);
            }
          }
          unobserve() {}
          disconnect() {}
        },
      ),
    );
    textWidth = 640;
    availableWidth = 320;
    remeasure = undefined;
    const nativeScrollWidth = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollWidth",
    )!.get!;
    const nativeClientWidth = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    )!.get!;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.closest("[data-incoming-message-placeholder]")
        ? textWidth
        : nativeScrollWidth.call(this);
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.closest("[data-incoming-message-placeholder]")
        ? availableWidth
        : nativeClientWidth.call(this);
    });
    const container = document.createElement("div");
    container.style.contain = "paint layout style";
    // Give Tab a stable starting point before this frame instead of retaining runner focus.
    const tabStart = document.createElement("span");
    tabStart.tabIndex = 0;
    document.body.append(tabStart);
    stack.defer(() => tabStart.remove());
    const screen = stack.use(await renderUi(null, { container }));
    await act(() => tabStart.focus());
    const owner = stack.move();
    return {
      container,
      rerender: screen.rerender,
      get textWidth() {
        return textWidth;
      },
      set textWidth(value: number) {
        textWidth = value;
      },
      get availableWidth() {
        return availableWidth;
      },
      set availableWidth(value: number) {
        availableWidth = value;
      },
      remeasure: () => remeasure?.(),
      [Symbol.asyncDispose]: () => owner.disposeAsync(),
    };
  }

  function summaryButton() {
    return [
      ...document.querySelectorAll<HTMLButtonElement>("button[data-incoming-message-summary]"),
    ].find((button) => !button.closest("[inert]"))!;
  }

  async function waitForPopupFocus(mode: "lifted" | "summary" | "closed") {
    await vi.waitFor(() => {
      const lift = document.querySelector("[data-incoming-message-lift]");
      if (mode === "lifted") expect(lift?.contains(document.activeElement)).toBe(true);
      else {
        if (mode === "closed") expect(lift).toBeNull();
        expect(document.activeElement).toBe(summaryButton());
      }
    });
  }

  it("opens the original only on request, keeps action focus lifted, and can collapse again", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;

    const original = "First original line.\nThe full original remains unopened until requested.";
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    const copy = vi.fn();
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({
          role: "user",
          createdBy: "agent",
          text: original,
          incomingSummary: {
            status: "ready",
            text: "A summary that is longer than the available one-line space.",
          },
        })}
        surface="neutral"
        fillColor={null}
        attachments={null}
        renderOriginal={renderOriginal}
        renderActions={() => (
          <button type="button" onClick={copy}>
            Copy original
          </button>
        )}
      />,
    );
    expect(renderOriginal).not.toHaveBeenCalled();
    await userEvent.tab();
    await vi.waitFor(() =>
      expect(container.querySelector("[data-incoming-message-lifted='true']")).not.toBeNull(),
    );
    const lift = document.querySelector<HTMLElement>("[data-incoming-message-lift]")!;
    expect(lift).not.toBeNull();
    expect(container.contains(lift)).toBe(false);
    expect(document.body.contains(lift)).toBe(true);
    await waitForPopupFocus("lifted");
    expect(lift.contains(document.activeElement)).toBe(true);
    const copyButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy original" && !button.closest("[inert]"),
    )!;
    await act(async () => copyButton.focus());
    expect(container.querySelector("[data-incoming-message-lifted='true']")).not.toBeNull();
    await act(async () => copyButton.click());
    expect(copy).toHaveBeenCalledOnce();
    expect(renderOriginal).not.toHaveBeenCalled();
    await act(async () => summaryButton().click());
    expect(container.textContent).toContain(original);
    const less = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Show less",
    )!;
    await act(async () => less.click());
    expect(container.textContent).not.toContain(original);
    expect(summaryButton().textContent).toContain("A summary");
    await waitForPopupFocus("summary");
    expect(document.activeElement).toBe(summaryButton());
    await rerender(null);
    expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
  });

  it("does not lift or render an unopened original while its summary is pending", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;

    const renderOriginal = vi.fn(() => <p>Original</p>);
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({
          role: "user",
          createdBy: "agent",
          text: "First line\nSecond line",
          incomingSummary: { status: "pending" },
        })}
        surface="outline"
        fillColor={null}
        attachments={null}
        renderOriginal={renderOriginal}
        renderActions={() => null}
      />,
    );
    await userEvent.tab();
    expect(container.querySelector("[data-incoming-message-lifted='true']")).toBeNull();
    expect(summaryButton().textContent).toBe("First line");
    expect(renderOriginal).not.toHaveBeenCalled();
  });

  it("keeps a short original verbatim and adds access only when the column clips it", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;

    fixture.textWidth = 200;
    fixture.availableWidth = 320;
    const original = "Short incoming original stays verbatim.";
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({
          role: "user",
          createdBy: "agent",
          text: original,
        })}
        surface="neutral"
        fillColor={null}
        attachments={null}
        renderOriginal={renderOriginal}
        renderActions={() => null}
      />,
    );
    const restingLine = [
      ...container.querySelectorAll<HTMLElement>("[data-incoming-message-summary]"),
    ].find((line) => !line.closest("[inert]"))!;
    expect(restingLine.textContent).toBe(original);
    expect(restingLine.tagName).toBe("DIV");
    expect(restingLine.querySelector("button, svg")).toBeNull();
    expect(renderOriginal).not.toHaveBeenCalled();

    await act(async () => {
      fixture.availableWidth = 160;
      fixture.remeasure?.();
    });
    expect(summaryButton().textContent).toBe(original);
    await userEvent.tab();
    expect(container.querySelector("[data-incoming-message-lifted='true']")).not.toBeNull();
    expect(renderOriginal).not.toHaveBeenCalled();
    await act(async () => summaryButton().click());
    expect(renderOriginal).toHaveBeenCalled();
    expect(container.textContent).toContain(original);
  });

  it("mounts full attachments once and only after opening an attachment-only message", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;

    fixture.textWidth = 0;
    const mounted = vi.fn();
    const removed = vi.fn();
    function Attachment() {
      useEffect(() => {
        mounted();
        return removed;
      }, []);
      return <button type="button">Open attachment preview</button>;
    }
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({ role: "user", createdBy: "agent", text: "" })}
        surface="outline"
        fillColor={null}
        attachmentCount={1}
        attachments={<Attachment />}
        renderOriginal={() => null}
        renderActions={() => null}
      />,
    );
    expect(mounted).not.toHaveBeenCalled();
    expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
    expect(summaryButton().getAttribute("aria-label")).toContain("1 attachment");
    await act(async () => summaryButton().click());
    expect(mounted).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("button")).toHaveLength(2);
    const less = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Show less",
    )!;
    await act(async () => less.click());
    expect(removed).toHaveBeenCalledOnce();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it("moves keyboard focus before the resting summary becomes unfocusable", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;
    let invalidatedFocus = false;
    let sawLift = false;
    const observer = new MutationObserver(() => {
      if (!container.querySelector("[data-incoming-message-lifted='true']")) return;
      sawLift = true;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        container.contains(active) &&
        active.closest("[inert]")
      ) {
        invalidatedFocus = true;
        // A browser may repair focus on the newly inert subtree before popup autofocus runs.
        active.blur();
      }
    });
    observer.observe(container, { attributes: true, childList: true, subtree: true });
    using _observer = { [Symbol.dispose]: () => observer.disconnect() };
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({
          role: "user",
          createdBy: "agent",
          text: "Original request.\nDetails continue here.",
          incomingSummary: {
            status: "ready",
            text: "Inspect status and continue the authorized work.",
          },
        })}
        surface="neutral"
        fillColor={null}
        attachments={null}
        renderOriginal={() => <p>Original request.</p>}
        renderActions={() => <button type="button">Copy original</button>}
      />,
    );
    await userEvent.tab();
    await waitForPopupFocus("lifted");
    expect(sawLift).toBe(true);
    expect(invalidatedFocus).toBe(false);
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Copy original");
    await userEvent.tab();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
      expect(container.contains(document.activeElement)).toBe(false);
    });
  });

  it.each(["summary", "copy"] as const)(
    "dismisses Escape from %s, restores focus, and lets Tab reach Copy without reopening",
    async (focusedControl) => {
      await using fixture = await setup();
      const { container, rerender } = fixture;

      const copy = vi.fn();
      await rerender(
        <IncomingMessageFrame
          preview={resolveIncomingMessagePreview({
            role: "user",
            createdBy: "agent",
            text: "Original request.\nDetails continue here.",
            incomingSummary: {
              status: "ready",
              text: "Inspect status and continue the authorized work.",
            },
          })}
          surface="neutral"
          fillColor={null}
          attachments={null}
          renderOriginal={() => <p>Original request.</p>}
          renderActions={() => (
            <button type="button" onClick={copy}>
              Copy original
            </button>
          )}
        />,
      );
      await userEvent.tab();
      await waitForPopupFocus("lifted");
      expect(document.querySelector("[data-incoming-message-lift]")).not.toBeNull();
      if (focusedControl === "copy") {
        const popupCopy = [
          ...document.querySelectorAll<HTMLButtonElement>("[data-incoming-message-lift] button"),
        ].find((button) => button.textContent === "Copy original")!;
        await act(async () => popupCopy.focus());
      }
      await act(async () =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      await waitForPopupFocus("closed");
      expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
      expect(document.activeElement).toBe(summaryButton());

      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(async () => document.activeElement?.dispatchEvent(tab));
      expect(tab.defaultPrevented).toBe(false);
      const liveButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => !button.closest("[inert]"),
      );
      const next = liveButtons[liveButtons.indexOf(summaryButton()) + 1]!;
      expect(next.textContent).toBe("Copy original");
      expect(next.parentElement?.style.opacity).not.toBe("0");
      await userEvent.tab();
      expect(document.activeElement).toBe(next);
      expect(next.parentElement?.style.opacity).not.toBe("0");
      expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
      await act(async () => next.click());
      expect(copy).toHaveBeenCalledOnce();
    },
  );

  it("keeps failed long fallback text truncated while its copy action remains usable", async () => {
    await using fixture = await setup();
    const { container, rerender } = fixture;

    const original = JSON.stringify({ request: "Inspect status. ".repeat(40) });
    const copy = vi.fn();
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    await rerender(
      <IncomingMessageFrame
        preview={resolveIncomingMessagePreview({
          role: "user",
          createdBy: "agent",
          text: original,
          incomingSummary: { status: "failed" },
        })}
        surface="neutral"
        fillColor={null}
        attachments={null}
        renderOriginal={renderOriginal}
        renderActions={() => (
          <button type="button" onClick={copy}>
            Copy original
          </button>
        )}
      />,
    );
    await userEvent.tab();
    expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
    expect(renderOriginal).not.toHaveBeenCalled();
    const copyButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy original" && !button.closest("[inert]"),
    )!;
    expect(copyButton.parentElement?.style.opacity).not.toBe("0");
    await act(async () => copyButton.click());
    expect(copy).toHaveBeenCalledOnce();
    await act(async () => summaryButton().click());
    expect(renderOriginal).toHaveBeenCalled();
  });
});
