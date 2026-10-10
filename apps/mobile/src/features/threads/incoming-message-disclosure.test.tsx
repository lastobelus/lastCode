// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import type { OrchestrationV2IncomingMessageSummary } from "@t3tools/contracts";

const nativeLayout = vi.hoisted(() => ({
  width: 320,
  lineCount: 1,
  onLayout: undefined as (() => void) | undefined,
  onTextLayout: undefined as (() => void) | undefined,
}));

vi.mock("react-native", async () => {
  const { useEffect } = await import("react");
  return {
    View: (props: {
      children?: ReactNode;
      accessibilityElementsHidden?: boolean;
      onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    }) => {
      const { onLayout } = props;
      useEffect(() => {
        if (!onLayout) return;
        const measure = () => onLayout({ nativeEvent: { layout: { width: nativeLayout.width } } });
        nativeLayout.onLayout = measure;
        measure();
        return () => {
          if (nativeLayout.onLayout === measure) nativeLayout.onLayout = undefined;
        };
      }, [onLayout]);
      return <div aria-hidden={props.accessibilityElementsHidden}>{props.children}</div>;
    },
    Pressable: (props: {
      children?: ReactNode;
      accessibilityLabel?: string;
      onPress?: () => void;
    }) => (
      <button type="button" aria-label={props.accessibilityLabel} onClick={props.onPress}>
        {props.children}
      </button>
    ),
    ActivityIndicator: () => <span role="progressbar" />,
  };
});

vi.mock("../../components/AppText", async () => {
  const { useEffect } = await import("react");
  return {
    AppText: (props: {
      children?: ReactNode;
      onTextLayout?: (event: { nativeEvent: { lines: Array<{ width: number }> } }) => void;
    }) => {
      const { onTextLayout } = props;
      useEffect(() => {
        if (!onTextLayout) return;
        const measure = () =>
          onTextLayout({
            nativeEvent: {
              lines: Array.from({ length: nativeLayout.lineCount }, () => ({
                width: nativeLayout.width,
              })),
            },
          });
        nativeLayout.onTextLayout = measure;
        measure();
        return () => {
          if (nativeLayout.onTextLayout === measure) nativeLayout.onTextLayout = undefined;
        };
      }, [onTextLayout]);
      return <span>{props.children}</span>;
    },
  };
});

vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => <i aria-hidden /> }));

import { IncomingMessageDisclosure } from "./incoming-message-disclosure";

describe("mobile incoming message access", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    nativeLayout.width = 320;
    nativeLayout.lineCount = 1;
    nativeLayout.onLayout = undefined;
    nativeLayout.onTextLayout = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    text: string,
    incomingSummary?: OrchestrationV2IncomingMessageSummary,
    attachmentCount = 0,
  ) {
    await act(() =>
      root.render(
        <IncomingMessageDisclosure
          preview={resolveIncomingMessagePreview({
            role: "user",
            createdBy: "agent",
            text,
            incomingSummary,
          })}
          attachmentCount={attachmentCount}
          attachments={attachmentCount ? <p data-attachment>Open attachment</p> : null}
        >
          <p data-original>{text}</p>
        </IncomingMessageDisclosure>,
      ),
    );
  }

  function button() {
    const result = container.querySelector<HTMLButtonElement>("button");
    if (!result) throw new Error("Expected the message disclosure");
    return result;
  }

  async function resize(width: number, lineCount: number) {
    nativeLayout.width = width;
    nativeLayout.lineCount = lineCount;
    await act(() => nativeLayout.onLayout?.());
    await act(() => nativeLayout.onTextLayout?.());
  }

  it("leaves a fitting short message plain and opens the original only when actual layout clips it", async () => {
    const text = "A short incoming original stays available.";
    await render(text);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-original]")).toBeNull();

    await resize(160, 2);
    expect(container.querySelector("[data-original]")).toBeNull();
    await act(() => button().click());
    expect(container.querySelector("[data-original]")?.textContent).toBe(text);

    // Widening must leave the open original closable, then remove the redundant disclosure.
    await resize(400, 1);
    expect(container.querySelector("[data-original]")?.textContent).toBe(text);
    await act(() => button().click());
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-original]")).toBeNull();
  });

  it("does not retain another preview's clipped state at the same width", async () => {
    nativeLayout.width = 160;
    nativeLayout.lineCount = 2;
    await render("The first short original wraps at the current mobile width.");
    expect(button()).toBeDefined();

    nativeLayout.lineCount = 1;
    await render("Done.");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-original]")).toBeNull();
  });

  it("labels an attachment-only message and keeps its attachment accessible", async () => {
    await render("", undefined, 1);
    expect(button().getAttribute("aria-label")).toBe("1 attachment");
    expect(container.querySelector("[data-attachment]")).toBeNull();
    await act(() => button().click());
    expect(container.querySelector("[data-attachment]")?.textContent).toBe("Open attachment");
    await act(() => button().click());
    expect(container.querySelector("[data-attachment]")).toBeNull();
  });

  it("keeps the original opened during pending visible when its summary arrives", async () => {
    const text = "Original first line.\nKeep the complete original available.";
    await render(text, { status: "pending" });
    expect(container.querySelector("[role=progressbar]")).not.toBeNull();
    expect(container.querySelector("[data-original]")).toBeNull();
    await act(() => button().click());
    const original = container.querySelector("[data-original]");

    await render(text, { status: "ready", text: "A completed summary." });
    expect(container.querySelector("[role=progressbar]")).toBeNull();
    expect(container.querySelector("[data-original]")).toBe(original);
    expect(container.textContent).toContain("A completed summary.");

    const hide = container.querySelector<HTMLButtonElement>("[aria-label='Hide original message']");
    await act(() => hide?.click());
    expect(container.querySelector("[data-original]")).toBeNull();
    const show = container.querySelector<HTMLButtonElement>("[aria-label='Show original message']");
    await act(() => show?.click());
    expect(container.querySelector("[data-original]")?.textContent).toBe(text);
  });

  it("allows a failed summary's long fallback to expand to the original", async () => {
    const text = "Original first line.\nThe remaining original instructions.";
    await render(text, { status: "failed" });
    expect(container.querySelector("[data-original]")).toBeNull();
    await act(() => button().click());
    expect(container.querySelector("[data-original]")?.textContent).toBe(text);
  });
});
