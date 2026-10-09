import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import { create } from "zustand";
import { readThreadPreviewState } from "~/previewStateStore";

interface RefreshRequest {
  readonly id: number;
  readonly url: string;
  readonly expectedUrl: string | null;
}

const keyFor = (ref: ScopedThreadRef, tabId: string) =>
  JSON.stringify([scopedThreadKey(ref), tabId]);
const useRequests = create<{ requests: Readonly<Record<string, RefreshRequest>> }>(() => ({
  requests: {},
}));
let sequence = 0;

/** Keep only a clean navigation intent until the existing viewer can dispatch it. */
export function requestHostedPreviewRefresh(ref: ScopedThreadRef, tabId: string, url: string) {
  const snapshot = readThreadPreviewState(ref).sessions[tabId];
  const expectedUrl =
    snapshot && snapshot.navStatus._tag !== "Idle"
      ? stripPreviewBootstrapTokenFromUrl(new URL(snapshot.navStatus.url)).href
      : null;
  const request = {
    id: ++sequence,
    url: stripPreviewBootstrapTokenFromUrl(new URL(url)).href,
    expectedUrl,
  };
  useRequests.setState((state) => ({
    requests: { ...state.requests, [keyFor(ref, tabId)]: request },
  }));
  return request.id;
}

export function useHostedPreviewRefresh(ref: ScopedThreadRef, tabId: string | null) {
  return useRequests((state) =>
    tabId === null ? null : (state.requests[keyFor(ref, tabId)] ?? null),
  );
}

export function completeHostedPreviewRefresh(ref: ScopedThreadRef, tabId: string, id: number) {
  useRequests.setState((state) => {
    const key = keyFor(ref, tabId);
    if (state.requests[key]?.id !== id) return state;
    const requests = { ...state.requests };
    delete requests[key];
    return { requests };
  });
}
