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
const THREAD_HREF = String.raw`t3-thread:\/\/v[12]\/`;
// Unescaped brackets end a label, so consecutive unclosed brackets cannot restart a long scan.
const LABEL = String.raw`(?:\\[^\n]|[^\\[\]\n])*`;
const LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*`;
const QUOTE_PREFIX = new RegExp(String.raw`^([ \t]*${LIST_MARKERS})(>(?:[ \t]*>)+)`, "gm");
// Move inter-marker spacing before the quote so fence depth matches and offsets stay intact. A label
// may span \r or U+2028, which multiline `^` follows, so labels and output are read from the original.
const threadLinkSource = (markdown: string) =>
  markdown.replace(QUOTE_PREFIX, (_source, indent: string, quote: string) => {
    const markers = quote.replace(/[ \t]/g, "");
    return indent + " ".repeat(quote.length - markers.length) + markers;
  });
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
// Four columns of indent where no container can explain it make indented code, not a fence: at the
// start of the text, after a list marker, or after a quote's optional space.
const NOT_INDENTED_CODE = String.raw`(?!(?<![\s\S])(?: {0,3}\t| {4}))`;
const OPENER_LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4}(?![ \t]))*`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^${NOT_INDENTED_CODE}[ \t]*${OPENER_LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]{0,4}(?![ \t])${OPENER_LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:(?:\r\n?|\n)(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:(?:\r\n?|\n)${closer})?`;
};
// A code span may wrap lines until its paragraph ends: a blank line, heading, list item, fence, rule,
// setext underline, or deeper blockquote.
const SPAN_BREAK_LINE =
  /[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|`{3,}[^`\r\n]*\r?$|~{3,})/my;
const LINE_PREFIX = /([ \t]*)(>|(?:[-*+]|\d{1,9}[.)])[ \t]+)?/y;
const THEMATIC_BREAK = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/;
const SETEXT_UNDERLINE = /^(?:-+|=+)[ \t]*\r?$/;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    fencedCode("`", "bt"),
    fencedCode("~", "tl"),
    String.raw`(?<spanTicks>\`+)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>|(?<href>${THREAD_HREF}[^\s>)]+|${HOSTED_LINK}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+|${HOSTED_LINK})>`,
    // After a URL character the hosted link is part of a longer URL, such as a redirect target.
    String.raw`(?<![A-Za-z0-9%/?#=&@+-])(?<bare>${HOSTED_LINK})(?![\w%/?#-])`,
  ].join("|"),
  "gm",
);

function codeSpanLines(markdown: string) {
  const lines: Array<{ start: number; depth: number; breaksSpan: boolean }> = [];
  const listIndents: number[] = [];
  let paragraphDepth: number | undefined;
  let start = 0;
  for (const rawLine of markdown.split(/(?<=\n)|(?<=\r)(?!\n)/u)) {
    const line = rawLine.replace(/[\r\n]+$/u, "");
    let offset = 0;
    let depth = 0;
    let hasList = false;
    let listOffset = 0;
    while (offset < line.length) {
      LINE_PREFIX.lastIndex = offset;
      const prefix = LINE_PREFIX.exec(line);
      if (prefix === null) break;
      const indent = prefix[1]!.replace(/\t/g, "    ").length;
      if (
        listOffset === 0 &&
        paragraphDepth === undefined &&
        indent < (listIndents[depth] ?? 0) &&
        line.trim()
      ) {
        listIndents.length = depth;
      }
      const containerIndent = listIndents[depth] ?? 0;
      const continuedIndent = indent >= containerIndent ? containerIndent : 0;
      if (prefix[2] === undefined || indent - continuedIndent > 3) break;
      offset = LINE_PREFIX.lastIndex;
      if (prefix[2] === ">") {
        depth++;
        listOffset = 0;
        if (line[offset] === " " || line[offset] === "\t") offset++;
      } else {
        listOffset += indent + prefix[2]!.replace(/\t/g, "    ").length;
        listIndents[depth] = listOffset;
        hasList = true;
      }
    }
    const content = line.slice(offset);
    const text = content.trimStart();
    const indent = content.slice(0, content.length - text.length).replace(/\t/g, "    ").length;
    const containerIndent = hasList ? 0 : (listIndents[depth] ?? 0);
    const lazy = indent < containerIndent || depth < (paragraphDepth ?? 0);
    // Rules and setext underlines end a paragraph unless indented as code; a lazy line is never an underline.
    const breaksSpan =
      !hasList &&
      (lazy ? indent : indent - containerIndent) <= 3 &&
      (THEMATIC_BREAK.test(text) ||
        (paragraphDepth !== undefined && !lazy && SETEXT_UNDERLINE.test(text)));
    const endsParagraph =
      breaksSpan ||
      /^(?:[ \t\r]*$|[ \t]*#{1,6}(?:[ \t]|$)|[ \t]*`{3,}[^`]*$|[ \t]*~{3,})/.test(content);
    const effectiveDepth = endsParagraph || hasList ? depth : Math.max(depth, paragraphDepth ?? 0);
    lines.push({ start, depth: effectiveDepth, breaksSpan });
    paragraphDepth = endsParagraph ? undefined : effectiveDepth;
    start += rawLine.length;
  }
  return lines;
}

function findCodeSpanEnd(
  markdown: string,
  openIndex: number,
  tickCount: number,
  lines: ReturnType<typeof codeSpanLines>,
  lineIndex: number,
): number {
  const openDepth = lines[lineIndex]!.depth;
  for (let i = openIndex + tickCount; i < markdown.length; i++) {
    if (markdown[i] === "`") {
      let runEnd = i + 1;
      while (markdown[runEnd] === "`") runEnd++;
      if (runEnd - i === tickCount) return runEnd;
      i = runEnd - 1;
    } else if (i + 1 === lines[lineIndex + 1]?.start) {
      lineIndex++;
      SPAN_BREAK_LINE.lastIndex = i + 1;
      const line = lines[lineIndex]!;
      if (SPAN_BREAK_LINE.test(markdown) || line.breaksSpan || line.depth > openDepth) return -1;
    }
  }
  return -1;
}

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

export function linkReference(link: ThreadLink): ThreadLinkReference {
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
  const href = threadLinkHref(ref);
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
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
  replaceThreadLinks(markdown, (link) => {
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(JSON.stringify([ref.environmentId, ref.threadId]), ref);
    }
    return undefined;
  });
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  // A leading BOM is not content: Markdown blocks such as fences start after it.
  if (markdown.startsWith("\uFEFF"))
    return `\uFEFF${replaceThreadLinks(markdown.slice(1), replace)}`;
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  const source = threadLinkSource(markdown);
  let result = "";
  let cursor = 0;
  let lines: ReturnType<typeof codeSpanLines> | undefined;
  let lineIndex = 0;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const spanTicks = match.groups?.spanTicks;
    if (spanTicks !== undefined) {
      lines ??= codeSpanLines(markdown);
      while (lineIndex + 1 < lines.length && lines[lineIndex + 1]!.start <= match.index)
        lineIndex++;
      const spanEnd = findCodeSpanEnd(markdown, match.index, spanTicks.length, lines, lineIndex);
      if (spanEnd !== -1) pattern.lastIndex = spanEnd;
      continue;
    }
    const href =
      match.groups?.angleHref ?? match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href);
    const label = match.groups?.label;
    const rewritten =
      link === null
        ? undefined
        : replace(link, label && markdown.slice(match.index + 1, match.index + 1 + label.length));
    if (rewritten === undefined) continue;
    result += markdown.slice(cursor, match.index) + rewritten;
    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? markdown : result + markdown.slice(cursor);
}

/** Browser links keep explicit destinations so the app can show unavailable or missing threads. */
export function browserThreadLinkTarget(
  href: string,
  sourceEnvironmentId: EnvironmentId,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const reference = parseThreadLinkReference(href);
  if (reference === null) return null;
  const resolved = resolveThreadLinkReference(reference, (threadId, environmentId) =>
    refs.find(
      (ref) =>
        ref.threadId === threadId && ref.environmentId === (environmentId ?? sourceEnvironmentId),
    ),
  );
  if (resolved.value) return resolved.value;
  const link = {
    environmentId: reference.environmentId ?? null,
    threadId: reference.threadId,
    version: reference.version,
    legacyThreadId: reference.legacyThreadId,
  };
  return (
    guessThreadLinkRef(link, refs) ?? {
      environmentId: resolved.environmentId ?? sourceEnvironmentId,
      threadId: resolved.threadId,
    }
  );
}
