import {
  prepareHostedPreview,
  type PrepareHostedPreviewInput,
} from "@t3tools/client-runtime/preview-hosting";

/** Resolve a managed preview before passing an HTTP URL to a native viewer. */
export async function prepareThenOpenThreadFeedUrl<A>(
  input: PrepareHostedPreviewInput,
  open: (url: string) => A | Promise<A>,
): Promise<A> {
  let destination = input.url;
  try {
    destination = (await prepareHostedPreview(input)).url;
  } catch {
    // Keep the user's original link usable if preparation unexpectedly fails.
  }
  return open(destination);
}
