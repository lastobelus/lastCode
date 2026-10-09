import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread as `[title](t3-thread://v1/<environmentId>/<threadId>)`.
 * Legacy links without an environment resolve in the message's environment. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** The ids as written, preserving percent escapes that are part of a thread id. */
export function parseThreadLinkReference(href: string): {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId;
} | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const path = href.slice(THREAD_LINK_HREF_PREFIX.length);
  const separator = path.indexOf("/");
  const threadId = Option.getOrNull(
    decodeThreadId(separator === -1 ? path : path.slice(separator + 1)),
  );
  if (threadId === null) return null;
  if (separator === -1) return { threadId };
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, separator)));
  return environmentId === null ? null : { environmentId, threadId };
}

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  return parseThreadLinkReference(href)?.threadId ?? null;
}

/**
 * Agents often percent-encode the id anyway. When the id as written names no thread, clients try
 * this decoded form. Null when decoding changes nothing or fails.
 */
export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. */
export function formatThreadLink(threadId: string, label: string, environmentId?: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const scope = environmentId === undefined ? "" : `${environmentId}/`;
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${scope}${threadId})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

/**
 * Relabels each thread link with `title(threadId)`, pointing it at the thread that title came from.
 * A link it returns nothing for keeps its label.
 */
export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId, environmentId?: EnvironmentId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const reference = parseThreadLinkReference(href);
    if (reference === null) return source;
    const { threadId: written, environmentId } = reference;
    // The decoded id only stands in when the id as written names no thread.
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written, environmentId) === undefined &&
      decoded !== null &&
      title(decoded, environmentId) !== undefined
        ? decoded
        : written;
    const label = title(threadId, environmentId)?.trim();
    return label ? formatThreadLink(threadId, label, environmentId) : source;
  });
}
