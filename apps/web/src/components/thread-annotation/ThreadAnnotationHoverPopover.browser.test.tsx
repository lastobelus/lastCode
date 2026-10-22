import { act, render } from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId, type ThreadAnnotation } from "@t3tools/contracts";
import { useState } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { PopoverCreateHandle as createPopoverHandle, PopoverTrigger } from "../ui/popover";
import {
  ThreadAnnotationHoverPopover,
  ThreadAnnotationNavigationTrigger,
} from "./ThreadAnnotation";

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

function HoverHarness({
  onNavigate,
  onRowClick,
  onEdit,
  annotationActive = true,
}: {
  onNavigate: () => void;
  onRowClick: () => void;
  onEdit: () => void;
  annotationActive?: boolean;
}) {
  const [handle] = useState(createPopoverHandle);
  return (
    <>
      <ThreadAnnotationNavigationTrigger
        annotationActive={annotationActive}
        handle={handle}
        id={navigationTriggerId}
        render={<div />}
        role="button"
        tabIndex={0}
        onClick={() => {
          onRowClick();
          onNavigate();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onNavigate();
        }}
      >
        Navigate to thread
        {annotationActive ? (
          <PopoverTrigger
            handle={handle}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            Show annotation
          </PopoverTrigger>
        ) : null}
      </ThreadAnnotationNavigationTrigger>
      <button type="button" style={{ position: "fixed", bottom: 0, left: 0 }}>
        Outside control
      </button>
      {annotationActive ? (
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
      ) : null}
    </>
  );
}

async function renderHoverCard() {
  const onNavigate = vi.fn();
  const onRowClick = vi.fn();
  const onEdit = vi.fn();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(<HoverHarness onNavigate={onNavigate} onRowClick={onRowClick} onEdit={onEdit} />),
  );
  // The browser pointer survives DOM cleanup between tests. Start away from the row.
  await userEvent.hover(button("Outside control"));
  await expect.poll(popup).toBeNull();
  const setAnnotationActive = (annotationActive: boolean) =>
    screen.rerender(
      <HoverHarness
        onNavigate={onNavigate}
        onRowClick={onRowClick}
        onEdit={onEdit}
        annotationActive={annotationActive}
      />,
    );
  const environment = stack.move();
  return {
    onNavigate,
    onRowClick,
    onEdit,
    setAnnotationActive,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
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
  await userEvent.hover(navigationTrigger());
  await expect.poll(popup).not.toBeNull();
}

async function leaveNavigation() {
  await userEvent.hover(button("Outside control"));
}

describe("ThreadAnnotationHoverPopover", () => {
  it("dismisses after pointer exit when a click leaves the navigation row focused", async () => {
    await using _fixture = await renderHoverCard();
    await hoverNavigation();
    // Programmatic focus does not establish pointer modality.
    const row = navigationTrigger();
    const matches = row.matches.bind(row);
    using _matches = vi
      .spyOn(row, "matches")
      .mockImplementation((selector) =>
        selector === ":focus-visible" ? false : matches(selector),
      );
    await act(() => {
      navigationTrigger().focus();
      navigationTrigger().click();
    });
    expect(document.activeElement).toBe(navigationTrigger());
    await leaveNavigation();
    await expect.poll(popup).toBeNull();
  });

  it("keeps the focused navigation row mounted when its annotation is resolved or reopened", async () => {
    await using fixture = await renderHoverCard();
    const { setAnnotationActive } = fixture;
    const row = navigationTrigger();
    await act(() => row.focus());
    for (const active of [false, true]) {
      await setAnnotationActive(active);
      expect(navigationTrigger()).toBe(row);
      expect(document.activeElement).toBe(row);
    }
  });

  it("does not restore an old open card when an annotation disappears and returns", async () => {
    await using fixture = await renderHoverCard();
    const { setAnnotationActive } = fixture;
    await hoverNavigation();
    await setAnnotationActive(false);
    await expect.poll(popup).toBeNull();
    await leaveNavigation();
    await setAnnotationActive(true);
    await expect.poll(popup).toBeNull();
    expect(document.querySelector("[data-base-ui-focus-guard]")).toBeNull();
  });

  it.each([
    { key: "Enter" },
    { key: " " },
    { key: "Enter", ctrlKey: true },
    { key: " ", ctrlKey: true },
    { key: "Enter", shiftKey: true },
    { key: " ", shiftKey: true },
  ])(
    "activates the composed navigation row once for $key with $ctrlKey/$shiftKey",
    async (keys) => {
      await using fixture = await renderHoverCard();
      const { onNavigate, onRowClick } = fixture;
      await act(() => {
        for (const type of ["keydown", "keyup"]) {
          navigationTrigger().dispatchEvent(
            new KeyboardEvent(type, { ...keys, bubbles: true, cancelable: true }),
          );
        }
      });
      expect(onNavigate).toHaveBeenCalledOnce();
      expect(onRowClick).not.toHaveBeenCalled();
    },
  );

  it.each(["focus outside", "Escape"] as const)(
    "keeps a focused Edit control after hover ends, then dismisses on %s",
    async (dismissal) => {
      await using _fixture = await renderHoverCard();
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
      await expect.poll(popup).toBeNull();
    },
  );

  it("opens from the annotation marker without navigating and lets Edit act", async () => {
    await using fixture = await renderHoverCard();
    const { onNavigate, onEdit } = fixture;
    await act(() => button("Show annotation").click());
    expect(popup()).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();

    await act(() => button("Edit").click());
    expect(onEdit).toHaveBeenCalledOnce();
    await expect.poll(popup).toBeNull();
  });

  it("still toggles a marker-opened card after focus enters its controls", async () => {
    await using _fixture = await renderHoverCard();
    await act(() => button("Show annotation").click());
    await act(() => button("Edit").focus());
    expect(popup()).not.toBeNull();
    await act(() => button("Show annotation").focus());
    await act(() => button("Show annotation").click());
    await expect.poll(popup).toBeNull();
  });

  it("navigates without pinning a hover card when the navigation trigger is clicked", async () => {
    await using fixture = await renderHoverCard();
    const { onNavigate } = fixture;
    await act(() => navigationTrigger().click());
    expect(onNavigate).toHaveBeenCalledOnce();
    await expect.poll(popup).toBeNull();

    await hoverNavigation();
    await act(() => navigationTrigger().click());
    expect(onNavigate).toHaveBeenCalledTimes(2);
    await leaveNavigation();
    await expect.poll(popup).toBeNull();
  });
});
