import {
  prepareHostedPreview,
  type PrepareHostedPreviewInput,
} from "@t3tools/client-runtime/preview-hosting";
import type { MediaActionsSource } from "./mediaActions";

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

/** Start preparing a direct media URL and ignore results after its source leaves the feed. */
export function startPreparingThreadFeedMediaUrl(
  url: string,
  prepare: (url: string) => Promise<string>,
  publish: (url: string) => void,
): () => void {
  let current = true;
  const publishIfCurrent = (value: string) => {
    if (current) publish(value);
  };

  if (!/^https?:\/\//i.test(url)) {
    publishIfCurrent(url);
  } else {
    void Promise.resolve()
      .then(() => (current ? prepare(url) : url))
      .then(publishIfCurrent, () => publishIfCurrent(url));
  }

  return () => {
    current = false;
  };
}

/** Keep copy/share actions aligned with the live URL while retaining authored metadata. */
export function preparedThreadFeedMediaActionsSource(
  source: MediaActionsSource | undefined,
  uri: string,
): MediaActionsSource | undefined {
  if (!source || !("uri" in source)) return source;
  const reference = source.reference;
  return {
    ...source,
    uri,
    ...(reference?.kind === "url" ? { reference: { ...reference, url: uri } } : {}),
  };
}

export function openThreadFeedMarkdownUrl<A>(
  input: Omit<PrepareHostedPreviewInput, "url"> | null,
  url: string,
  open: (url: string) => A | Promise<A>,
): Promise<A> {
  return input === null
    ? Promise.resolve(open(url))
    : prepareThenOpenThreadFeedUrl({ ...input, url }, open);
}
