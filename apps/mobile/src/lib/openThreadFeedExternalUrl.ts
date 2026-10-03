import {
  prepareHostedPreview,
  type PrepareHostedPreviewInput,
} from "@t3tools/client-runtime/preview-hosting";

export async function openThreadFeedExternalUrl(
  input: PrepareHostedPreviewInput & {
    readonly openExternal: (url: string) => Promise<boolean>;
  },
): Promise<boolean> {
  let destination = input.url;
  try {
    destination = (await prepareHostedPreview(input)).url;
  } catch {
    // Keep the user's original link usable if preparation unexpectedly fails.
  }
  return input.openExternal(destination);
}
