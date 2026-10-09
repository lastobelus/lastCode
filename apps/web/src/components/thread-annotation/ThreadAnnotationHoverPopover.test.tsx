// @vitest-environment happy-dom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId, type ThreadAnnotation } from "@t3tools/contracts";
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { PopoverCreateHandle as createPopoverHandle, PopoverTrigger } from "../ui/popover";
import { ThreadAnnotationHoverPopover } from "./ThreadAnnotation";

// Markdown rendering is unrelated to the popup interaction and requires a router.
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

const annotation: ThreadAnnotation = {
  anchorMessageId: MessageId.make("annotation-anchor"),
  body: "Follow up on this thread",
  createdAt: "2026-09-03T00:00:00.000Z",
  resolvedAt: null,
  updatedAt: "2026-09-03T00:00:00.000Z",
};
const threadRef = scopeThreadRef(
  EnvironmentId.make("annotation-test-environment"),
  ThreadId.make("annotation-test-thread"),
);
const navigationTriggerId = "annotation-navigation";

function HoverHarness({ onNavigate, onEdit }: { onNavigate: () => void; onEdit: () => void }) {
  const handle = useMemo(() => createPopoverHandle(), []);
  return (
    <>
      <PopoverTrigger
        delay={0}
        handle={handle}
        id={navigationTriggerId}
        nativeButton={false}
        openOnHover
        render={<div />}
        role="button"
        tabIndex={0}
        onClick={onNavigate}
      >
        Navigate to thread
        <PopoverTrigger
          handle={handle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          Show annotation
        </PopoverTrigger>
      </PopoverTrigger>
      <button type="button">Outside control</button>
      <ThreadAnnotationHoverPopover
        annotation={annotation}
        threadRef={threadRef}
        handle={handle}
        navigationTriggerId={navigationTriggerId}
        threadDetails={<div>Thread details</div>}
        onEdit={onEdit}
        onResolve={() => undefined}
        onBodyChange={async () => true}
      />
    </>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const previousActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterAll(() => {
  if (previousActEnvironment) {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
});

async function renderHoverCard() {
  const onNavigate = vi.fn();
  const onEdit = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<HoverHarness onNavigate={onNavigate} onEdit={onEdit} />));
  return { onNavigate, onEdit };
}

function button(label: string) {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(element, `Expected button labelled ${label}`).toBeDefined();
  return element!;
}

function navigationTrigger() {
  const element = document.getElementById(navigationTriggerId);
  expect(element).not.toBeNull();
  return element!;
}

function popup() {
  return document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
}

async function hoverNavigation() {
  await act(() => {
    navigationTrigger().dispatchEvent(new MouseEvent("mouseenter", { clientX: 10, clientY: 10 }));
  });
  expect(popup()).not.toBeNull();
}

async function leaveNavigation() {
  await act(() => {
    navigationTrigger().dispatchEvent(
      new MouseEvent("mouseleave", { clientX: -100, clientY: -100 }),
    );
    document.body.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: -100, clientY: -100 }),
    );
  });
}

describe("ThreadAnnotationHoverPopover", () => {
  it.each(["focus outside", "Escape"] as const)(
    "keeps a focused Edit control after hover ends, then dismisses on %s",
    async (dismissal) => {
      await renderHoverCard();
      await hoverNavigation();
      const edit = button("Edit");
      await act(() => edit.focus());
      expect(document.activeElement).toBe(edit);

      await leaveNavigation();
      expect(popup()).not.toBeNull();
      expect(document.activeElement).toBe(edit);

      const resolve = button("Resolve");
      await act(() => resolve.focus());
      expect(popup()).not.toBeNull();
      expect(document.activeElement).toBe(resolve);

      await act(() => {
        if (dismissal === "focus outside") button("Outside control").focus();
        else resolve.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(popup()).toBeNull();
    },
  );

  it("opens from the annotation marker without navigating and lets Edit act", async () => {
    const { onNavigate, onEdit } = await renderHoverCard();
    await act(() => button("Show annotation").click());
    expect(popup()).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();

    await act(() => button("Edit").click());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();
  });

  it("navigates without pinning a hover card when the navigation trigger is clicked", async () => {
    const { onNavigate } = await renderHoverCard();
    await act(() => navigationTrigger().click());
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();

    await hoverNavigation();
    await act(() => navigationTrigger().click());
    expect(onNavigate).toHaveBeenCalledTimes(2);
    await leaveNavigation();
    expect(popup()).toBeNull();
  });
});
