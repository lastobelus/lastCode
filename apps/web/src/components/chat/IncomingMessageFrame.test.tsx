// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import { IncomingMessageFrame } from "./IncomingMessageFrame";

describe("incoming message interaction", () => {
  let root: Root;
  let container: HTMLDivElement;
  let textWidth: number;
  let availableWidth: number;
  let remeasure: (() => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
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
    );
    textWidth = 640;
    availableWidth = 320;
    remeasure = undefined;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => textWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => availableWidth);
    container = document.createElement("div");
    container.style.contain = "paint layout style";
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function summaryButton() {
    return [
      ...document.querySelectorAll<HTMLButtonElement>("button[data-incoming-message-summary]"),
    ].find((button) => !button.closest("[inert]"))!;
  }

  async function flushPopupFocus() {
    // Base UI schedules initial focus on the next animation frame.
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }

  it("opens the original only on request, keeps action focus lifted, and can collapse again", async () => {
    const original = "First original line.\nThe full original remains unopened until requested.";
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    const copy = vi.fn();
    await act(async () =>
      root.render(
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
      ),
    );
    expect(renderOriginal).not.toHaveBeenCalled();
    await act(async () => summaryButton().focus());
    expect(container.querySelector("[data-incoming-message-lifted='true']")).not.toBeNull();
    const lift = document.querySelector<HTMLElement>("[data-incoming-message-lift]")!;
    expect(lift).not.toBeNull();
    expect(container.contains(lift)).toBe(false);
    expect(document.body.contains(lift)).toBe(true);
    await flushPopupFocus();
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
    await flushPopupFocus();
    expect(document.activeElement).toBe(summaryButton());
    await act(async () => root.render(null));
    expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
  });

  it("does not lift or render an unopened original while its summary is pending", async () => {
    const renderOriginal = vi.fn(() => <p>Original</p>);
    await act(async () =>
      root.render(
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
      ),
    );
    await act(async () => summaryButton().focus());
    expect(container.querySelector("[data-incoming-message-lifted='true']")).toBeNull();
    expect(summaryButton().textContent).toBe("First line");
    expect(renderOriginal).not.toHaveBeenCalled();
  });

  it("keeps a short original verbatim and adds access only when the column clips it", async () => {
    textWidth = 200;
    availableWidth = 320;
    const original = "Short incoming original stays verbatim.";
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    await act(async () =>
      root.render(
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
      ),
    );
    const restingLine = [
      ...container.querySelectorAll<HTMLElement>("[data-incoming-message-summary]"),
    ].find((line) => !line.closest("[inert]"))!;
    expect(restingLine.textContent).toBe(original);
    expect(restingLine.tagName).toBe("DIV");
    expect(restingLine.querySelector("button, svg")).toBeNull();
    expect(renderOriginal).not.toHaveBeenCalled();

    await act(async () => {
      availableWidth = 160;
      remeasure?.();
    });
    expect(summaryButton().textContent).toBe(original);
    await act(async () => summaryButton().focus());
    expect(container.querySelector("[data-incoming-message-lifted='true']")).not.toBeNull();
    expect(renderOriginal).not.toHaveBeenCalled();
    await act(async () => summaryButton().click());
    expect(renderOriginal).toHaveBeenCalled();
    expect(container.textContent).toContain(original);
  });

  it("mounts full attachments once and only after opening an attachment-only message", async () => {
    textWidth = 0;
    const mounted = vi.fn();
    const removed = vi.fn();
    function Attachment() {
      useEffect(() => {
        mounted();
        return removed;
      }, []);
      return <button type="button">Open attachment preview</button>;
    }
    await act(async () =>
      root.render(
        <IncomingMessageFrame
          preview={resolveIncomingMessagePreview({ role: "user", createdBy: "agent", text: "" })}
          surface="outline"
          fillColor={null}
          attachmentCount={1}
          attachments={<Attachment />}
          renderOriginal={() => null}
          renderActions={() => null}
        />,
      ),
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

  it.each(["summary", "copy"] as const)(
    "dismisses Escape from %s, restores focus, and lets Tab reach Copy without reopening",
    async (focusedControl) => {
      const copy = vi.fn();
      await act(async () =>
        root.render(
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
        ),
      );
      await act(async () => summaryButton().focus());
      await flushPopupFocus();
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
      await flushPopupFocus();
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
      // JSDOM has no native Tab default action; follow its live DOM tab order.
      await act(async () => next.focus());
      expect(document.activeElement).toBe(next);
      expect(next.parentElement?.style.opacity).not.toBe("0");
      expect(document.querySelector("[data-incoming-message-lift]")).toBeNull();
      await act(async () => next.click());
      expect(copy).toHaveBeenCalledOnce();
    },
  );

  it("keeps failed long fallback text truncated while its copy action remains usable", async () => {
    const original = JSON.stringify({ request: "Inspect status. ".repeat(40) });
    const copy = vi.fn();
    const renderOriginal = vi.fn(() => <p>{original}</p>);
    await act(async () =>
      root.render(
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
      ),
    );
    await act(async () => summaryButton().focus());
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
