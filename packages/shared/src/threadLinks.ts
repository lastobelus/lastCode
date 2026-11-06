import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DEFAULT_HOSTED_APP_URL } from "./connectAuth.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const HOSTED_PREFIX = `${DEFAULT_HOSTED_APP_URL}/threads/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const HOSTED_LINK = `${HOSTED_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  String.raw`(?<fence>(\`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(\`+)[^\n]*?\4)|\[(?<label>[^\]\n]*)\]\((?<href>t3-thread:\/\/v[12]\/[^\s)]+|${HOSTED_LINK})\)|<(?<autolink>t3-thread:\/\/v[12]\/[^\s<>]+|${HOSTED_LINK})>|(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  "g",
);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
  // Scoped V1 paths also name a legacy local ID; keep that ambiguity through client resolution.
  readonly version?: 1 | 2;
  readonly legacyThreadId?: ThreadId | undefined;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const hostedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Opens the thread from anywhere: the hosted app offers the desktop app, the mobile app, or itself. */
export function hostedThreadLink(ref: ScopedThreadRef, origin = DEFAULT_HOSTED_APP_URL): string {
  const path = `/threads/${hostedSegment(ref.environmentId)}/${hostedSegment(ref.threadId)}`;
  return new URL(path, origin).toString();
}

const HOSTED_PATH = new RegExp(`^(${HOSTED_SEGMENT})/(${HOSTED_SEGMENT})$`);

function parseHostedThreadLink(href: string): ThreadLinkReference | null {
  const match = HOSTED_PATH.exec(href.slice(HOSTED_PREFIX.length));
  if (!match) return null;
  try {
    const environmentId = Option.getOrNull(decodeEnvironmentId(decodeURIComponent(match[1]!)));
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(match[2]!)));
    return environmentId === null || threadId === null
      ? null
      : { environmentId, threadId, version: 2 };
  } catch {
    return null;
  }
}

export interface ThreadLinkReference {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId | undefined;
  readonly version: 1 | 2;
  readonly legacyThreadId?: ThreadId | undefined;
}

/** V2 segments decode once. V1 ids preserve their literal percent escapes. */
export function parseThreadLinkReference(href: string): ThreadLinkReference | null {
  if (href.startsWith(HOSTED_PREFIX)) {
    return parseHostedThreadLink(href);
  }
  if (href.startsWith(V2_PREFIX)) {
    const segments = href.slice(V2_PREFIX.length).split("/");
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
  if (!href.startsWith(V1_PREFIX)) return null;
  const path = href.slice(V1_PREFIX.length);
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

function referenceCandidates(reference: ThreadLinkReference) {
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
  return candidates;
}

/** Prefer existing scoped V1 targets; unresolved ambiguous V1 paths retain their legacy local target. */
export function resolveThreadLinkReference<T>(
  reference: ThreadLinkReference,
  lookup: (threadId: ThreadId, environmentId?: EnvironmentId) => T | undefined,
): {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId | undefined;
  readonly value: T | undefined;
} {
  const primary = { threadId: reference.threadId, environmentId: reference.environmentId };
  const candidates = referenceCandidates(reference);
  for (const candidate of candidates) {
    const value = lookup(candidate.threadId, candidate.environmentId);
    if (value !== undefined) return { ...candidate, value };
  }
  if (reference.version === 1 && reference.legacyThreadId !== undefined) {
    return { threadId: reference.legacyThreadId, environmentId: undefined, value: undefined };
  }
  return { ...primary, value: undefined };
}

export function parseThreadLinkHref(href: string): ThreadLink | null {
  const reference = parseThreadLinkReference(href);
  if (reference === null) return null;
  const link = { environmentId: reference.environmentId ?? null, threadId: reference.threadId };
  return reference.legacyThreadId === undefined
    ? link
    : { ...link, version: reference.version, legacyThreadId: reference.legacyThreadId };
}

function linkReference(link: ThreadLink): ThreadLinkReference {
  return {
    threadId: link.threadId,
    environmentId: link.environmentId ?? undefined,
    version: link.version ?? (link.environmentId === null ? 1 : 2),
    legacyThreadId: link.legacyThreadId,
  };
}

function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** V2 names one exact target. V1 tries literal, decoded, then legacy local slash IDs. */
export function threadLinkCandidates(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return referenceCandidates(linkReference(link)).map(({ environmentId, threadId }) => ({
    environmentId: environmentId ?? messageEnvironmentId,
    threadId,
  }));
}

/** A v1 link its message's environment lacks opens a unique match elsewhere; a v2 link never does. */
export function guessThreadLinkRef(
  link: ThreadLink,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const reference = linkReference(link);
  if (reference.version === 2) return null;
  const legacyId = reference.legacyThreadId ?? reference.threadId;
  const decodedId = percentDecodedThreadLinkId(legacyId);
  for (const threadId of decodedId === null ? [legacyId] : [legacyId, decodedId]) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

export function resolveThreadLinkRef(
  source: ScopedThreadRef,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const link = { environmentId: null, threadId: source.threadId };
  for (const candidate of threadLinkCandidates(link, source.environmentId)) {
    const local = refs.find(
      (ref) => ref.environmentId === candidate.environmentId && ref.threadId === candidate.threadId,
    );
    if (local) return local;
  }
  return guessThreadLinkRef(link, refs);
}

function threadLinkHref(link: ThreadLink): string {
  return link.environmentId === null
    ? `${V1_PREFIX}${link.threadId}`
    : `${V2_PREFIX}${encodeLinkSegment(link.environmentId)}/${encodeLinkSegment(link.threadId)}`;
}

function encodeLinkSegment(id: string): string {
  return encodeURIComponent(id).replace(/[()]/g, (character) =>
    character === "(" ? "%28" : "%29",
  );
}

const linkLabel = (label: string | undefined) =>
  label
    ?.replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Without a label, an autolink: clients show the thread's current title. */
export function formatThreadLink(ref: ThreadLink, label?: string): string {
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${threadLinkHref(ref)})` : `<${threadLinkHref(ref)}>`;
}

/** What a person copies out of T3 Code: a Markdown link that opens the thread anywhere. */
export function formatHostedThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin?: string,
): string {
  const href = hostedThreadLink(ref, origin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) || markdown.includes(HOSTED_PREFIX);
}

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    const href = match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    if (link === null) continue;
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(JSON.stringify([ref.environmentId, ref.threadId]), ref);
    }
  }
  return [...refs.values()];
}

export function unknownThreadLinkLabel(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): string {
  return link.legacyThreadId !== undefined ||
    link.environmentId === null ||
    link.environmentId === messageEnvironmentId
    ? "Thread no longer available"
    : "Thread on another machine";
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const groups = args.at(-1) as Partial<Record<"href" | "autolink" | "bare" | "label", string>>;
    const href = groups.href ?? groups.autolink ?? groups.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    return (link && replace(link, groups.label)) ?? source;
  });
}

/**
 * Writes each link with its thread's current title, a hosted link as a v2 link. A link `title`
 * cannot resolve becomes plain text, its written label or a neutral one, except a labeled v1
 * link, which may open elsewhere.
 */
export function relabelThreadLinks(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  title: (ref: ScopedThreadRef) => string | undefined,
): string {
  return replaceThreadLinks(markdown, (written, label) => {
    const reference = linkReference(written);
    const resolved = resolveThreadLinkReference(reference, (threadId, environmentId) =>
      title({ threadId, environmentId: environmentId ?? messageEnvironmentId }),
    );
    const current = resolved.value;
    if (current === undefined) {
      if (label !== undefined && reference.version === 1) return undefined;
      return label?.trim() || unknownThreadLinkLabel(written, messageEnvironmentId);
    }
    return formatThreadLink(
      { environmentId: resolved.environmentId ?? null, threadId: resolved.threadId },
      current.trim() || label || resolved.threadId,
    );
  });
}
