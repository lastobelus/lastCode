import {
  prepareHostedPreview,
  HostedPreviewUrlTooLongError,
  HostedPreviewRecoveryError,
  hostedPreviewNavigationUrl,
  type PreparedHostedPreview,
  type PrepareHostedPreviewInput,
} from "@t3tools/client-runtime/preview-hosting";
import type { MediaActionsSource } from "./mediaActionsSource";

/** Resolve a managed preview before passing an HTTP URL to a native viewer. */
export async function prepareThenOpenThreadFeedUrl<A>(
  input: PrepareHostedPreviewInput,
  open: (url: string) => A | Promise<A>,
  openManagedBrowser?: (url: string) => A | Promise<A>,
): Promise<A> {
  let destination = input.url;
  let prepared: PreparedHostedPreview | undefined;
  try {
    const { createResourceUrl: _resource, ...navigationInput } = input;
    prepared = await prepareHostedPreview(
      openManagedBrowser !== undefined && input.purpose !== "resource"
        ? { ...navigationInput, purpose: "resource" }
        : input,
    );
    destination =
      input.purpose === "resource"
        ? (prepared.resourceUrl ?? prepared.url)
        : hostedPreviewNavigationUrl(prepared);
  } catch (cause) {
    if (
      cause instanceof HostedPreviewUrlTooLongError ||
      cause instanceof HostedPreviewRecoveryError
    )
      throw cause;
    // Keep the user's original link usable if preparation unexpectedly fails.
  }
  if (
    input.purpose !== "resource" &&
    prepared?.managed &&
    prepared.localUrl !== undefined &&
    openManagedBrowser !== undefined
  )
    return openManagedBrowser(prepared.localUrl);
  return open(destination);
}

export type ThreadFeedMediaPreparation =
  | { readonly status: "pending"; readonly uri: null }
  | { readonly status: "ready"; readonly uri: string }
  | { readonly status: "unavailable"; readonly uri: null };

/** Start preparing a direct media URL and ignore results after its source leaves the feed. */
export function startPreparingThreadFeedMediaUrl(
  url: string,
  prepare: (url: string) => Promise<string>,
  publish: (result: Exclude<ThreadFeedMediaPreparation, { status: "pending" }>) => void,
): () => void {
  let current = true;
  const publishIfCurrent = (value: Exclude<ThreadFeedMediaPreparation, { status: "pending" }>) => {
    if (current) publish(value);
  };

  if (!/^https?:\/\//i.test(url)) {
    publishIfCurrent({ status: "ready", uri: url });
  } else {
    void Promise.resolve()
      .then(() => (current ? prepare(url) : url))
      .then(
        (uri) => publishIfCurrent({ status: "ready", uri }),
        (cause: unknown) => {
          publishIfCurrent(
            cause instanceof HostedPreviewUrlTooLongError ||
              cause instanceof HostedPreviewRecoveryError
              ? { status: "unavailable", uri: null }
              : { status: "ready", uri: url },
          );
        },
      );
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
  openManagedBrowser?: (url: string) => A | Promise<A>,
): Promise<A> {
  return input === null
    ? Promise.resolve(open(url))
    : prepareThenOpenThreadFeedUrl({ ...input, url }, open, openManagedBrowser);
}
