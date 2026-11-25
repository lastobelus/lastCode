import type { PreviewAnnotationRect, PreviewAnnotationScreenshot } from "@t3tools/contracts";
import type { WebContents } from "electron";

/** Capture the guest surface first: Electron can reject cropped guest captures
 * while the complete surface is still capturable. */
export function captureAnnotationImage(
  wc: Pick<WebContents, "capturePage" | "executeJavaScript">,
  cropRect: PreviewAnnotationRect | null,
): Promise<PreviewAnnotationScreenshot>;
export function captureAnnotationImage(
  wc: Pick<WebContents, "capturePage" | "executeJavaScript">,
  cropRect: PreviewAnnotationRect | null,
  targetRects: ReadonlyArray<PreviewAnnotationRect>,
): Promise<PreviewAnnotationScreenshot | null>;
export async function captureAnnotationImage(
  wc: Pick<WebContents, "capturePage" | "executeJavaScript">,
  cropRect: PreviewAnnotationRect | null,
  targetRects?: ReadonlyArray<PreviewAnnotationRect>,
): Promise<PreviewAnnotationScreenshot | null> {
  const viewport: { width: number; height: number } = await wc.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  const source = await wc.capturePage();
  const sourceSize = source.getSize();
  if (
    source.isEmpty() ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    if (targetRects !== undefined) return null;
    throw new Error("The annotation viewport has no capturable image");
  }
  // Padding and unions can cross the viewport while every selected target is offscreen.
  // A zero-width or zero-height SVG line may still paint on its top or left edge.
  if (
    targetRects &&
    targetRects.length > 0 &&
    !targetRects.some(
      (rect) =>
        (rect.width > 0 || rect.height > 0) &&
        rect.x < viewport.width &&
        rect.y < viewport.height &&
        (rect.width === 0 ? rect.x >= 0 : rect.x + rect.width > 0) &&
        (rect.height === 0 ? rect.y >= 0 : rect.y + rect.height > 0),
    )
  )
    return null;
  const requested = cropRect ?? { x: 0, y: 0, ...viewport };
  const left = Math.max(0, requested.x);
  const top = Math.max(0, requested.y);
  const right = Math.min(viewport.width, requested.x + requested.width);
  const bottom = Math.min(viewport.height, requested.y + requested.height);
  if (right <= left || bottom <= top) {
    if (targetRects !== undefined) return null;
    throw new Error("The annotation crop is outside the viewport");
  }
  // The picker uses top-document CSS pixels. The image uses the guest surface's
  // pixels, which can differ with page zoom and a scaled preview in the host.
  const scaleX = sourceSize.width / viewport.width;
  const scaleY = sourceSize.height / viewport.height;
  const x = Math.floor(left * scaleX);
  const y = Math.floor(top * scaleY);
  const image = source.crop({
    x,
    y,
    width: Math.min(sourceSize.width, Math.ceil(right * scaleX)) - x,
    height: Math.min(sourceSize.height, Math.ceil(bottom * scaleY)) - y,
  });
  if (image.isEmpty()) {
    if (targetRects !== undefined) return null;
    throw new Error("The annotation crop is empty");
  }
  return {
    dataUrl: image.toDataURL(),
    ...image.getSize(),
    cropRect: { x: left, y: top, width: right - left, height: bottom - top },
  };
}
