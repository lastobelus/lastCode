import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationPrompt,
  capturePreviewAnnotationScreenshot,
  extractTrailingPreviewAnnotation,
} from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [
    {
      id: "stroke_1",
      color: "#7c3aed",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      bounds: { x: 6, y: 6, width: 18, height: 18 },
    },
  ],
  styleChanges: [
    {
      targetId: "element_1",
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotations", () => {
  it("describes regions, drawings, styles, and screenshot context", () => {
    const result = buildPreviewAnnotationPrompt(annotation);
    expect(result).toContain("Make these cards feel related.");
    expect(result).toContain("1 marked region");
    expect(result).toContain("1 drawing");
    expect(result).toContain("border-radius: 4px → 16px");
    expect(result).toContain("attached screenshot");
  });

  it("appends to an existing composer prompt", () => {
    expect(
      appendPreviewAnnotationPrompt("Fix this", annotation).startsWith(
        "Fix this\n\n<preview_annotation>",
      ),
    ).toBe(true);
  });

  it("extracts annotation presentation from a sent prompt", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", annotation),
    );
    expect(result.promptText).toBe("Fix this");
    expect(result.annotation).toMatchObject({
      title: "Example",
      targetSummary: "1 marked region, 1 drawing.",
      hasScreenshot: true,
    });
  });

  it("extracts multiple trailing annotations one at a time", () => {
    const first = appendPreviewAnnotationPrompt("Fix this", annotation);
    const secondAnnotation = { ...annotation, id: "annotation_2", pageTitle: "Details" };
    const second = appendPreviewAnnotationPrompt(first, secondAnnotation);
    const extractedSecond = extractTrailingPreviewAnnotation(second);
    const extractedFirst = extractTrailingPreviewAnnotation(extractedSecond.promptText);
    expect(extractedSecond.annotation?.id).toBe("annotation_2");
    expect(extractedFirst.annotation?.id).toBe("annotation_1");
    expect(extractedFirst.promptText).toBe("Fix this");
  });
});

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves native PNG bytes without fetching under the desktop security policy", async () => {
    const fetch = vi.fn(() => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 127, 128, 255]);
    const capture = await capturePreviewAnnotationScreenshot({
      ...annotation,
      screenshot: {
        ...annotation.screenshot!,
        dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`,
      },
    });
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") throw new Error("Expected screenshot attachment");
    expect(capture.file.name).toBe("preview-annotation-annotation_1.png");
    expect(capture.file.type).toBe("image/png");
    expect(new Uint8Array(await capture.file.arrayBuffer())).toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("yields while decoding large crops and preserves bytes across chunk boundaries", async () => {
    vi.useFakeTimers();
    const encoded = "AP+A".repeat(150_000);
    let settled = false;
    const pending = capturePreviewAnnotationScreenshot({
      ...annotation,
      screenshot: { ...annotation.screenshot!, dataUrl: `data:image/png;base64,${encoded}` },
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toBe("captured");
    if (result.status !== "captured") throw new Error("Expected screenshot attachment");
    const bytes = new Uint8Array(await result.file.arrayBuffer());
    expect(bytes.length).toBe(450_000);
    expect(bytes.every((byte, index) => byte === [0, 255, 128][index % 3])).toBe(true);
  });

  it("reports none when the annotation carries no crop", async () => {
    expect(await capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null })).toEqual({
      status: "none",
    });
  });

  it.each(["data:image/png;base64,!!!", "data:image/png;base64,", "https://example.com/image.png"])(
    "keeps the annotation sendable when its screenshot is invalid: %s",
    async (dataUrl) => {
      expect(
        await capturePreviewAnnotationScreenshot({
          ...annotation,
          screenshot: { ...annotation.screenshot!, dataUrl },
        }),
      ).toEqual({ status: "failed" });
    },
  );
});
