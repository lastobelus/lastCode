import { EnvironmentId, MessageId, ThreadId, type ThreadAnnotation } from "@t3tools/contracts";
import { threadAnnotationId } from "@t3tools/shared/threadAnnotation";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { runThreadAnnotationBodySave } from "../thread-annotation/ThreadAnnotation";
import { TimelineMinimap } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./timelineMinimapItems";
import "~/index.css";

function setup() {
  const note = (body: string, anchor: string, resolved = false): ThreadAnnotation => ({
    id: body,
    body: `- [ ] ${body}`,
    anchorMessageId: MessageId.make(anchor),
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    resolvedAt: resolved ? "2026-09-03T00:00:00.000Z" : null,
  });
  const notes = [
    note("Current", "loaded"),
    note("Resolved", "loaded", true),
    note("Earlier", "unloaded", true),
    { ...note("Legacy", "also-unloaded", true), id: undefined },
  ];
  const annotation = { ...notes[0]!, otherAnnotations: notes.slice(1) };
  const items: TimelineMinimapItem[] = ["loaded", "newest"].map((id, rowIndex) => ({
    id,
    messageId: MessageId.make(id),
    rowIndex,
    userText: id,
    assistantText: null,
    isIncoming: false,
    summaryPending: false,
    isSummary: false,
    isShortOriginal: false,
  }));
  const props = {
    annotation,
    items,
    currentIndex: 0,
    atEnd: false,
    hasPersistentGutter: true,
    hitStripWidth: 24,
    markdownCwd: undefined,
    stripMap: new Map<string, HTMLSpanElement>(),
    threadRef: {
      environmentId: EnvironmentId.make("minimap-test"),
      threadId: ThreadId.make("minimap-thread"),
    },
    onWheel: vi.fn(),
    onSelect: vi.fn(),
    onAnnotationEdit: vi.fn(),
    onAnnotationResolve: vi.fn(),
    onAnnotationReopen: vi.fn(),
    onAnnotationBodyChange: vi.fn(async () => true),
  };
  return { notes, props };
}

function markers() {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="timeline-minimap"] button[aria-label*="annotation" i]',
    ),
  ];
}

function marker(id: string) {
  const result = markers().find((button) => button.dataset.annotationId === id);
  expect(result, `Marker for ${id}`).toBeDefined();
  return result!;
}

const reopenButton = () => page.getByRole("button", { name: "Reopen", exact: true });
const reopenBlockedReason = () =>
  page.getByText(
    "Resolve the current annotation to reopen this one, or copy what you need into it.",
  );

describe("TimelineMinimap annotations", () => {
  it("exposes every loaded and earlier note separately without overlapping shared anchors", async () => {
    const { notes, props } = setup();
    await using screen = await render(<TimelineMinimap {...props} />);
    expect(markers()).toHaveLength(4);
    const current = marker(threadAnnotationId(notes[0]!)).getBoundingClientRect();
    const resolved = marker(threadAnnotationId(notes[1]!)).getBoundingClientRect();
    expect(current.y).toBe(resolved.y);
    expect(current.right).toBeLessThanOrEqual(resolved.left);
    const earlier = marker(threadAnnotationId(notes[2]!));
    const legacy = marker(threadAnnotationId(notes[3]!));
    expect(earlier.closest("[data-thread-annotation-overflow]")).not.toBeNull();
    expect(legacy.closest("[data-thread-annotation-overflow]")).not.toBeNull();
    expect(earlier.getBoundingClientRect().right).toBeLessThanOrEqual(
      legacy.getBoundingClientRect().left,
    );
    for (const loaded of [current, resolved]) {
      for (const old of [earlier, legacy]) {
        const box = old.getBoundingClientRect();
        expect(
          loaded.right <= box.left ||
            box.right <= loaded.left ||
            loaded.bottom <= box.top ||
            box.bottom <= loaded.top,
        ).toBe(true);
      }
    }
    const longItems = Array.from({ length: 1_000 }, (_, index) => ({
      ...props.items[0]!,
      id: `message-${index}`,
      messageId: MessageId.make(`message-${index}`),
      rowIndex: index,
    }));
    const nearbyNotes = notes.map((note, index) => ({
      ...note,
      anchorMessageId: longItems[index]!.messageId,
    }));
    await screen.rerender(
      <TimelineMinimap
        {...props}
        items={longItems}
        annotation={{ ...nearbyNotes[0]!, otherAnnotations: nearbyNotes.slice(1) }}
      />,
    );
    await vi.waitFor(() => {
      const boxes = nearbyNotes.map((note) =>
        marker(threadAnnotationId(note)).getBoundingClientRect(),
      );
      for (let first = 0; first < boxes.length; first++) {
        for (let second = first + 1; second < boxes.length; second++) {
          const a = boxes[first]!,
            b = boxes[second]!;
          expect(
            a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
          ).toBe(true);
        }
      }
    });
  });

  it("keeps crowded history reachable inside the map with keyboard focus", async () => {
    const { notes, props } = setup();
    const crowded = Array.from({ length: 100 }, (_, index) => ({
      ...notes[1]!,
      id: `history-${index}`,
      body: `History ${index}`,
    }));
    await using screen = await render(
      <TimelineMinimap
        {...props}
        annotation={{ ...crowded[0]!, otherAnnotations: crowded.slice(1) }}
      />,
    );
    for (const anchorMessageId of [MessageId.make("loaded"), MessageId.make("unloaded")]) {
      await screen.rerender(
        <TimelineMinimap
          {...props}
          annotation={{
            ...crowded[0]!,
            anchorMessageId,
            otherAnnotations: crowded.slice(1).map((note) => ({ ...note, anchorMessageId })),
          }}
        />,
      );
      const last = marker("history-99");
      await act(() => last.focus());
      const bounds = document
        .querySelector('[data-testid="timeline-minimap"]')!
        .getBoundingClientRect();
      await vi.waitFor(() => {
        const box = last.getBoundingClientRect();
        expect(box.left).toBeGreaterThanOrEqual(bounds.left);
        expect(box.right).toBeLessThanOrEqual(bounds.right);
      });
      await act(() => last.click());
      await expect.element(page.getByText("History 99", { exact: true })).toBeVisible();
      await act(() => last.click());
    }
  });

  it("moves only the resolved note to its new anchor and preserves edit and reopen anchors", async () => {
    const { notes, props } = setup();
    await using screen = await render(<TimelineMinimap {...props} />);
    const currentId = threadAnnotationId(notes[0]!);
    const resolvedId = threadAnnotationId(notes[1]!);
    const initialTop = marker(currentId).getBoundingClientRect().top;
    const initialEarlierTop = marker(threadAnnotationId(notes[2]!)).getBoundingClientRect().top;
    const resolvedCurrent = {
      ...notes[0]!,
      resolvedAt: notes[0]!.updatedAt,
      anchorMessageId: MessageId.make("newest"),
    };
    await screen.rerender(
      <TimelineMinimap
        {...props}
        annotation={{ ...resolvedCurrent, otherAnnotations: notes.slice(1) }}
      />,
    );
    expect(marker(currentId).getBoundingClientRect().top).toBeGreaterThan(initialTop);
    expect(marker(resolvedId).getBoundingClientRect().top).toBe(initialTop);
    expect(marker(threadAnnotationId(notes[2]!)).getBoundingClientRect().top).toBe(
      initialEarlierTop,
    );
    await screen.rerender(
      <TimelineMinimap
        {...props}
        annotation={{
          ...notes[1]!,
          body: "Edited and reopened",
          resolvedAt: null,
          otherAnnotations: [resolvedCurrent, ...notes.slice(2)],
        }}
      />,
    );
    expect(marker(resolvedId).getBoundingClientRect().top).toBe(initialTop);
    expect(marker(currentId).getBoundingClientRect().top).toBeGreaterThan(initialTop);
  });

  it("opens one targeted note and routes edit, resolve, reopen and task changes to its stable ID", async () => {
    const { notes, props } = setup();
    await using screen = await render(<TimelineMinimap {...props} />);
    expect(markers()).toHaveLength(4);
    for (const note of notes) {
      const id = threadAnnotationId(note);
      await act(() => marker(id).click());
      await expect.element(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await expect.element(page.getByText(note.body.slice(6), { exact: true })).toBeVisible();
      expect(
        document.querySelectorAll('[data-minimap-preview] input[type="checkbox"]'),
      ).toHaveLength(1);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      expect(props.onAnnotationEdit).toHaveBeenLastCalledWith(id);
      if (note.resolvedAt) {
        await expect.element(reopenButton()).toBeDisabled();
        await expect.element(reopenBlockedReason()).toBeVisible();
      } else {
        await page.getByRole("button", { name: "Resolve", exact: true }).click();
        expect(props.onAnnotationResolve).toHaveBeenLastCalledWith(id);
        await expect.element(reopenBlockedReason()).not.toBeInTheDocument();
      }
      await page.getByRole("checkbox").click();
      expect(props.onAnnotationBodyChange).toHaveBeenLastCalledWith(
        note.body.replace("[ ]", "[x]"),
        id,
      );
    }
    expect(props.onAnnotationReopen).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    // A head change must retain the currently targeted legacy note, rather than switching its popup.
    await screen.rerender(
      <TimelineMinimap
        {...props}
        annotation={{
          ...notes[1]!,
          resolvedAt: null,
          otherAnnotations: [
            notes[3]!,
            { ...notes[0]!, resolvedAt: notes[0]!.updatedAt },
            notes[2]!,
          ],
        }}
      />,
    );
    await expect.element(page.getByText("Legacy", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    expect(props.onAnnotationEdit).toHaveBeenLastCalledWith(threadAnnotationId(notes[3]!));
  });

  it("enables Reopen once no note is active, while a pending save still disables it", async () => {
    const { notes, props } = setup();
    const resolvedNotes = notes.map((note) => ({
      ...note,
      resolvedAt: note.resolvedAt ?? note.updatedAt,
    }));
    await using _screen = await render(
      <TimelineMinimap
        {...props}
        annotation={{ ...resolvedNotes[0]!, otherAnnotations: resolvedNotes.slice(1) }}
      />,
    );
    for (const note of resolvedNotes) {
      const id = threadAnnotationId(note);
      await act(() => marker(id).click());
      await expect.element(page.getByText(note.body.slice(6), { exact: true })).toBeVisible();
      await expect.element(reopenButton()).toBeEnabled();
      await expect.element(reopenBlockedReason()).not.toBeInTheDocument();
      await reopenButton().click();
      expect(props.onAnnotationReopen).toHaveBeenLastCalledWith(id);
    }
    let finishSave: () => void = () => {};
    const save = runThreadAnnotationBodySave(
      props.threadRef,
      () => new Promise<boolean>((resolve) => (finishSave = () => resolve(true))),
    );
    await expect.element(reopenButton()).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
    finishSave();
    await save;
    await expect.element(reopenButton()).toBeEnabled();
  });
});
