import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { useState } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { ThreadAnnotationEditorDialog } from "./ThreadAnnotation";

const originalAnnotation: ThreadAnnotation = {
  anchorMessageId: MessageId.make("annotation-anchor"),
  body: "# Follow up\n\n- [ ] Confirm the fix",
  createdAt: "2026-09-03T00:00:00.000Z",
  resolvedAt: null,
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const hideUntil = {
  threadRef: {
    environmentId: EnvironmentId.make("annotation-environment"),
    threadId: ThreadId.make("annotation-thread"),
  },
  serverVersion: "0.1.11-nightly.20261120.4979.1",
};

function EditorHarness(props: {
  annotation: ThreadAnnotation | null;
  onOpenChange?: (open: boolean) => void;
  onSave: Parameters<typeof ThreadAnnotationEditorDialog>[0]["onSave"];
  hideUntil?: Parameters<typeof ThreadAnnotationEditorDialog>[0]["hideUntil"];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open editor
      </button>
      <ThreadAnnotationEditorDialog
        annotation={props.annotation}
        hideUntil={props.hideUntil}
        open={open}
        onOpenChange={(nextOpen) => {
          props.onOpenChange?.(nextOpen);
          setOpen(nextOpen);
        }}
        onSave={props.onSave}
      />
    </>
  );
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button, `Expected a button labelled ${label}`).toBeDefined();
  await act(() => button?.click());
}

function annotationTextarea() {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Thread annotation"]',
  );
  expect(textarea).not.toBeNull();
  return textarea!;
}

async function enterDraft(value: string) {
  const textarea = annotationTextarea();
  await userEvent.fill(textarea, value);
}

describe("ThreadAnnotationEditorDialog", () => {
  it("loads the saved Markdown when a closed editor opens", async () => {
    await using _screen = await render(
      <EditorHarness annotation={originalAnnotation} onSave={vi.fn(async () => true)} />,
    );

    expect(document.querySelector('textarea[aria-label="Thread annotation"]')).toBeNull();
    await clickButton("Open editor");

    expect(annotationTextarea().value).toBe(originalAnnotation.body);
  });

  it("discards an unsaved draft after cancel and reopen", async () => {
    await using _screen = await render(
      <EditorHarness annotation={originalAnnotation} onSave={vi.fn(async () => true)} />,
    );
    await clickButton("Open editor");
    await enterDraft("Unsaved replacement");

    await clickButton("Cancel");
    await clickButton("Open editor");

    expect(annotationTextarea().value).toBe(originalAnnotation.body);
  });

  it("preserves the draft when the saved annotation updates while the editor is open", async () => {
    const onSave = vi.fn(async () => true);
    await using _screen = await render(
      <EditorHarness annotation={originalAnnotation} onSave={onSave} />,
    );
    await clickButton("Open editor");
    await enterDraft("Draft being actively edited");

    const refreshedAnnotation: ThreadAnnotation = {
      ...originalAnnotation,
      body: "Saved by another refresh",
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    await _screen.rerender(<EditorHarness annotation={refreshedAnnotation} onSave={onSave} />);

    expect(annotationTextarea().value).toBe("Draft being actively edited");
  });

  it("submits trimmed text and closes after a successful save", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn(async () => true);
    await using _screen = await render(
      <EditorHarness annotation={originalAnnotation} onOpenChange={onOpenChange} onSave={onSave} />,
    );
    await clickButton("Open editor");
    await enterDraft("  ## Updated note\n\nNew details  ");

    await clickButton("Save");

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({ body: "## Updated note\n\nNew details" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
  it("arms a checkpoint trigger with an empty body", async () => {
    const onSave = vi.fn(async () => true);
    await using _screen = await render(
      <EditorHarness annotation={null} onSave={onSave} hideUntil={hideUntil} />,
    );
    await clickButton("Open editor");
    await expect.element(page.getByRole("button", { name: "Add annotation" })).toBeDisabled();
    await page.getByRole("combobox", { name: "Hide thread until" }).click();
    await page.getByRole("option", { name: /Checkpoints installed/ }).click();

    expect(annotationTextarea().value).toBe("");
    await expect
      .element(page.getByText("This environment is on 2026-11-20 • 4979.1"))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Hide thread", exact: true }).click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      hideUntil: { kind: "checkpoints", count: 1 },
    });
  });

  it("shows a trigger-only thread from the editor without writing its generated body", async () => {
    const onSave = vi.fn(async () => true);
    const id = CommandId.make("armed-trigger");
    await using _screen = await render(
      <EditorHarness
        annotation={{
          ...originalAnnotation,
          body: "Generated label",
          bodyGenerated: true,
          hideUntil: {
            id,
            hiddenAt: originalAnnotation.createdAt,
            kind: "checkpoints",
            count: 1,
            baselineVersion: hideUntil.serverVersion,
            seenBuilds: [],
          },
        }}
        onSave={onSave}
        hideUntil={hideUntil}
      />,
    );
    await clickButton("Open editor");
    expect(annotationTextarea().value).toBe("");
    await page.getByRole("combobox", { name: "Hide thread until" }).click();
    await page.getByRole("option", { name: "Don't hide" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ hideUntil: null, expectedHideTriggerId: id });
  });
});
