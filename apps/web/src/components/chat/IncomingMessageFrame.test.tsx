// @vitest-environment jsdom
import { act } from "react";
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
        constructor(callback: () => void) {
          remeasure = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    textWidth = 640;
    availableWidth = 320;
    remeasure = undefined;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => textWidth);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => availableWidth);
    container = document.createElement("div");
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
    return container.querySelector<HTMLButtonElement>(
      "button[data-incoming-message-summary]:not([tabindex='-1'])",
    )!;
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
    const copyButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
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
    expect(document.activeElement).toBe(summaryButton());
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
});
