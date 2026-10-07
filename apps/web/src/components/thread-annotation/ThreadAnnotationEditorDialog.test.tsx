// @vitest-environment happy-dom

import { MessageId, type ThreadAnnotation } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { ThreadAnnotationEditorDialog } from "./ThreadAnnotation";

const originalAnnotation: ThreadAnnotation = {
  anchorMessageId: MessageId.make("annotation-anchor"),
  body: "# Follow up\n\n- [ ] Confirm the fix",
  createdAt: "2026-09-03T00:00:00.000Z",
  resolvedAt: null,
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function EditorHarness(props: {
  annotation: ThreadAnnotation | null;
  onOpenChange?: (open: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open editor
      </button>
      <ThreadAnnotationEditorDialog
        annotation={props.annotation}
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

async function renderEditor(props: React.ComponentProps<typeof EditorHarness>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root?.render(<EditorHarness {...props} />));
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
  await act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ThreadAnnotationEditorDialog", () => {
  it("loads the saved Markdown when a closed editor opens", async () => {
    await renderEditor({ annotation: originalAnnotation, onSave: vi.fn(async () => true) });

    expect(document.querySelector('textarea[aria-label="Thread annotation"]')).toBeNull();
    await clickButton("Open editor");

    expect(annotationTextarea().value).toBe(originalAnnotation.body);
  });

  it("discards an unsaved draft after cancel and reopen", async () => {
    await renderEditor({ annotation: originalAnnotation, onSave: vi.fn(async () => true) });
    await clickButton("Open editor");
    await enterDraft("Unsaved replacement");

    await clickButton("Cancel");
    await clickButton("Open editor");

    expect(annotationTextarea().value).toBe(originalAnnotation.body);
  });

  it("preserves the draft when the saved annotation updates while the editor is open", async () => {
    const onSave = vi.fn(async () => true);
    await renderEditor({ annotation: originalAnnotation, onSave });
    await clickButton("Open editor");
    await enterDraft("Draft being actively edited");

    const refreshedAnnotation: ThreadAnnotation = {
      ...originalAnnotation,
      body: "Saved by another refresh",
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    await act(() =>
      root?.render(<EditorHarness annotation={refreshedAnnotation} onSave={onSave} />),
    );

    expect(annotationTextarea().value).toBe("Draft being actively edited");
  });

  it("submits trimmed text and closes after a successful save", async () => {
    const onOpenChange = vi.fn();
    const onSave = vi.fn(async () => true);
    await renderEditor({ annotation: originalAnnotation, onOpenChange, onSave });
    await clickButton("Open editor");
    await enterDraft("  ## Updated note\n\nNew details  ");

    await clickButton("Save");

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith("## Updated note\n\nNew details");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
