import { type PickedElementPayload, PickedElementPayloadSchema } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  elementContextToPreviewAnnotation,
  normalizeElementContextSelection,
} from "./elementContext";

it("preserves nested frame context through preview annotation conversion", () => {
  const raw = makePayload({
    pageUrl: "about:srcdoc",
    framePath: [
      { pageUrl: "https://example.com/editor", selector: "iframe:nth-child(1)" },
      { pageUrl: "about:srcdoc", selector: "iframe.preview" },
    ],
  });
  const context = normalizeElementContextSelection(
    Schema.decodeUnknownSync(PickedElementPayloadSchema)(raw),
  )!;
  expect(context.framePath).toEqual(raw.framePath);
  const annotation = elementContextToPreviewAnnotation(
    context,
    "annotation-1",
    "2026-05-03T18:00:00.000Z",
  );
  expect(annotation.elements[0]?.element.framePath).toEqual(raw.framePath);
});

function makePayload(overrides?: Partial<PickedElementPayload>): PickedElementPayload {
  return {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "BUTTON",
    selector: "button.submit",
    htmlPreview: '<button class="submit">Save</button>',
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/src/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    stack: [
      {
        functionName: "SubmitButton",
        fileName: "/repo/src/Button.tsx",
        lineNumber: 12,
        columnNumber: 5,
      },
    ],
    styles: ".submit { color: white; }",
    pickedAt: "2026-05-03T18:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeElementContextSelection", () => {
  it("clamps oversized htmlPreview / styles so we don't blow localStorage", () => {
    const huge = "x".repeat(10_000);
    const result = normalizeElementContextSelection(
      makePayload({ htmlPreview: huge, styles: huge }),
    );
    expect(result).not.toBeNull();
    expect(result!.htmlPreview.length).toBeLessThanOrEqual(4000);
    expect(result!.styles.length).toBeLessThanOrEqual(4000);
    expect(result!.htmlPreview.endsWith("…")).toBe(true);
    expect(result!.styles.endsWith("…")).toBe(true);
  });
});
