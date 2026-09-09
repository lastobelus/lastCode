import { describe, expect, it, vi } from "vite-plus/test";
import type { NativeImage } from "electron";

import { captureAnnotationImage } from "./AnnotationScreenshot.ts";

function guest(width = 1280, height = 800) {
  const crop = vi.fn((rect: { width: number; height: number }) => ({
    getSize: () => ({ width: rect.width, height: rect.height }),
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,crop",
  }));
  const source = {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    crop,
  } as unknown as NativeImage;
  return {
    crop,
    source,
    wc: {
      executeJavaScript: vi.fn(async () => ({ width: 1280, height: 800 })),
      capturePage: vi.fn(async (...args: unknown[]) => {
        // Reproduce the native guest failure: the full surface works but
        // Chromium rejects a direct crop in the scaled host.
        if (args.length) throw new Error("UnknownVizError");
        return source;
      }),
    },
  };
}

describe("annotation screenshot", () => {
  it("crops the complete native image using translated iframe coordinates", async () => {
    const { wc, crop } = guest();
    const rect = { x: 810, y: 250, width: 350, height: 60 };
    expect(await captureAnnotationImage(wc, rect)).toEqual({
      dataUrl: "data:image/png;base64,crop",
      width: 350,
      height: 60,
      cropRect: rect,
    });
    expect(wc.capturePage).toHaveBeenCalledWith();
    expect(crop).toHaveBeenCalledWith(rect);
  });

  it("maps CSS coordinates to the captured surface and rounds edges outward", async () => {
    const { wc, crop } = guest(640, 400);
    const rect = { x: 811, y: 253, width: 352, height: 64 };
    const screenshot = await captureAnnotationImage(wc, rect);
    expect(crop).toHaveBeenCalledWith({ x: 405, y: 126, width: 177, height: 33 });
    expect(screenshot.cropRect).toEqual(rect);
  });

  it("clips right and bottom edges after scrolling without shifting the crop", async () => {
    const { wc, crop } = guest(2560, 1600);
    const screenshot = await captureAnnotationImage(wc, {
      x: 1200,
      y: 760,
      width: 200,
      height: 100,
    });
    expect(crop).toHaveBeenCalledWith({ x: 2400, y: 1520, width: 160, height: 80 });
    expect(screenshot.cropRect).toEqual({ x: 1200, y: 760, width: 80, height: 40 });
  });

  it("clips negative edges and supports a full viewport annotation", async () => {
    const { wc, crop } = guest();
    await captureAnnotationImage(wc, { x: -20, y: -10, width: 100, height: 70 });
    expect(crop).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 80, height: 60 });
    const screenshot = await captureAnnotationImage(wc, null);
    expect(screenshot.cropRect).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("rejects empty or offscreen captures so the manager can keep the annotation", async () => {
    const { wc, source } = guest();
    await expect(
      captureAnnotationImage(wc, {
        x: 1300,
        y: 0,
        width: 20,
        height: 20,
      }),
    ).rejects.toThrow("outside the viewport");
    vi.spyOn(source, "isEmpty").mockReturnValue(true);
    await expect(captureAnnotationImage(wc, null)).rejects.toThrow("no capturable image");
  });
});
