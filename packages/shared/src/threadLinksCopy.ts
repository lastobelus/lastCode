import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  formatThreadLink,
  linkReference,
  replaceThreadLinks,
  resolveThreadLinkReference,
  type ThreadLink,
} from "./threadLinks.ts";

/** @public */
export function unknownThreadLinkLabel(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  resolve: MFunctionType = mFallback,
): string {
  return link.legacyThreadId !== undefined ||
    link.environmentId === null ||
    link.environmentId === messageEnvironmentId
    ? resolve(msg("Thread no longer available"))
    : resolve(msg("Thread on another machine"));
}

/**
 * Writes each link with its thread's current title, a hosted link as a v2 link. A link `title`
 * cannot resolve becomes plain text, its written label or a neutral one, except a labeled v1
 * link, which may open elsewhere. A fallback title can keep a link usable while its title is
 * unavailable, without treating the fallback as evidence that the destination exists.
 */
export function relabelThreadLinks(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  title: (ref: ScopedThreadRef, label: string | undefined) => string | undefined,
  resolve: MFunctionType = mFallback,
  fallbackTitle?: (ref: ScopedThreadRef, label: string | undefined) => string | undefined,
): string {
  return replaceThreadLinks(markdown, (written, label) => {
    const reference = linkReference(written);
    const resolved = resolveThreadLinkReference(reference, (threadId, environmentId) =>
      title({ threadId, environmentId: environmentId ?? messageEnvironmentId }, label),
    );
    let current = resolved.value;
    if (current === undefined) {
      if (label !== undefined && reference.version === 1) return undefined;
      current = fallbackTitle?.(
        { threadId: resolved.threadId, environmentId: resolved.environmentId ?? messageEnvironmentId },
        label,
      );
      if (current === undefined) {
        return label?.trim() || unknownThreadLinkLabel(written, messageEnvironmentId, resolve);
      }
    }
    return formatThreadLink(
      { environmentId: resolved.environmentId ?? null, threadId: resolved.threadId },
      current.trim() || label || resolved.threadId,
    );
  });
}
