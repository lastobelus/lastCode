import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread as `[title](t3-thread://v2/<encodedEnvironmentId>/<encodedThreadId>)`.
 * Legacy links without an environment resolve in the message's environment. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const SCOPED_THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v[12]\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

export interface ThreadLinkReference {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId | undefined;
  readonly version: 1 | 2;
  readonly legacyThreadId?: ThreadId | undefined;
}

/** V2 segments decode once. V1 ids preserve their literal percent escapes. */
export function parseThreadLinkReference(href: string): ThreadLinkReference | null {
  if (href.startsWith(SCOPED_THREAD_LINK_HREF_PREFIX)) {
    const segments = href.slice(SCOPED_THREAD_LINK_HREF_PREFIX.length).split("/");
    if (segments.length !== 2) return null;
    try {
      const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(segments[0]!)));
      const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(segments[1]!)));
      return environmentId === null || threadId === null
        ? null
        : { environmentId, threadId, version: 2 };
    } catch {
      return null;
    }
  }
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const path = href.slice(THREAD_LINK_HREF_PREFIX.length);
  const separator = path.indexOf("/");
  const legacyThreadId = Option.getOrNull(decodeThreadId(path));
  const threadId = Option.getOrNull(
    decodeThreadId(separator === -1 ? path : path.slice(separator + 1)),
  );
  if (threadId === null) {
    return legacyThreadId === null ? null : { threadId: legacyThreadId, version: 1 };
  }
  if (separator === -1) return { threadId, version: 1 };
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, separator)));
  return environmentId === null
    ? legacyThreadId === null
      ? null
      : { threadId: legacyThreadId, version: 1 }
    : {
        environmentId,
        threadId,
        version: 1,
        legacyThreadId: legacyThreadId ?? undefined,
      };
}

/** Prefer existing scoped V1 targets, then an existing legacy local path; keep unknown destinations. */
export function resolveThreadLinkReference<T>(
  reference: ThreadLinkReference,
  lookup: (threadId: ThreadId, environmentId?: EnvironmentId) => T | undefined,
): {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId | undefined;
  readonly value: T | undefined;
} {
  const primary = { threadId: reference.threadId, environmentId: reference.environmentId };
  const candidates = [primary];
  if (reference.version === 1) {
    const decoded = percentDecodedThreadLinkId(reference.threadId);
    if (decoded !== null) candidates.push({ ...primary, threadId: decoded });
    if (reference.legacyThreadId !== undefined) {
      candidates.push({ threadId: reference.legacyThreadId, environmentId: undefined });
      const decodedLegacy = percentDecodedThreadLinkId(reference.legacyThreadId);
      if (decodedLegacy !== null)
        candidates.push({ threadId: decodedLegacy, environmentId: undefined });
    }
  }
  for (const candidate of candidates) {
    const value = lookup(candidate.threadId, candidate.environmentId);
    if (value !== undefined) return { ...candidate, value };
  }
  return { ...primary, value: undefined };
}

/** The primary thread id: verbatim for V1, decoded once for V2. */
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
  const href =
    environmentId === undefined
      ? `${THREAD_LINK_HREF_PREFIX}${threadId}`
      : `${SCOPED_THREAD_LINK_HREF_PREFIX}${encodeLinkSegment(environmentId)}/${encodeLinkSegment(threadId)}`;
  return `[${cleaned || threadId}](${href})`;
}

function encodeLinkSegment(id: string): string {
  return encodeURIComponent(id).replace(/[()]/g, (character) =>
    character === "(" ? "%28" : "%29",
  );
}

export function hasThreadLinks(markdown: string): boolean {
  return (
    markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`) ||
    markdown.includes(`](${SCOPED_THREAD_LINK_HREF_PREFIX}`)
  );
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
    const resolved = resolveThreadLinkReference(reference, title);
    const label = resolved.value?.trim();
    return label ? formatThreadLink(resolved.threadId, label, resolved.environmentId) : source;
  });
}
