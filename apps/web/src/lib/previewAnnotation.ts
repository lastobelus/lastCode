import type { PreviewAnnotationPayload } from "@t3tools/contracts";

export type PreviewAnnotationCapture =
  | { readonly status: "captured"; readonly file: File }
  | { readonly status: "none" }
  | { readonly status: "failed" };

/** Decode the native PNG locally: the desktop CSP intentionally blocks data-URL fetches. */
export async function capturePreviewAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
): Promise<PreviewAnnotationCapture> {
  if (!annotation.screenshot) return { status: "none" };
  try {
    const prefix = "data:image/png;base64,";
    const dataUrl = annotation.screenshot.dataUrl;
    if (!dataUrl.startsWith(prefix)) return { status: "failed" };
    const encoded = dataUrl.slice(prefix.length);
    if (!encoded.length) return { status: "failed" };
    // Decode in base64-aligned chunks so large crops yield to input and painting,
    // and never retain a full-size intermediate binary string.
    const chunkSize = 256 * 1024;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < encoded.length; offset += chunkSize) {
      const binary = atob(encoded.slice(offset, offset + chunkSize));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }
      chunks.push(bytes);
      if (offset + chunkSize < encoded.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return {
      status: "captured",
      file: new File(chunks, `preview-annotation-${annotation.id}.png`, { type: "image/png" }),
    };
  } catch {
    return { status: "failed" };
  }
}
