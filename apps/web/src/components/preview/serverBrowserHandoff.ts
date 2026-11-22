import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import {
  recordHandoff,
  rememberHandoffBrowser,
  resolveKnownHandoffUrl,
} from "~/handoffs/handoffsStore";

const rememberedReveals = new Map<string, string>();
const keyFor = (ref: ScopedThreadRef, tabId: string) =>
  JSON.stringify([scopedThreadKey(ref), tabId]);

/** Records accepted browser handoffs without changing the selected thread or surface. */
export async function recordServerBrowserHandoff(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot,
): Promise<void> {
  if (
    snapshot.runtime !== "server" ||
    snapshot.reveal !== true ||
    snapshot.navStatus._tag === "Idle"
  )
    return;
  const key = keyFor(ref, snapshot.tabId);
  const requestId = snapshot.revealRequest?.id ?? "opened";
  if (rememberedReveals.get(key) === requestId) return;
  rememberedReveals.set(key, requestId);
  try {
    if (
      snapshot.revealRequest?.force !== true &&
      !(await resolveBrowserDefaults()).autoShowFloatingPreview
    )
      return;
    const url = snapshot.navStatus.url;
    const target = resolveKnownHandoffUrl(ref, url) ?? { kind: "url" as const, url };
    recordHandoff(ref, target);
    rememberHandoffBrowser(ref, snapshot.tabId, target, url);
  } catch {
    // Settings may not be readable yet. A later snapshot can retry this reveal.
    if (rememberedReveals.get(key) === requestId) rememberedReveals.delete(key);
  }
}

export function forgetServerBrowserHandoff(ref: ScopedThreadRef, tabId: string): void {
  rememberedReveals.delete(keyFor(ref, tabId));
}
