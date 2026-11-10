import { create } from "zustand";

interface PendingDemand {
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

interface DesktopBrowserDemand {
  ready: boolean;
  request: ((url?: string) => () => void) | null;
  url: string | undefined;
  release: (() => void) | null;
  pending: Set<PendingDemand>;
}

const demands = new Map<string, DesktopBrowserDemand>();
const useDesktopBrowserFailures = create<{ readonly byTabId: Readonly<Record<string, string>> }>(
  () => ({
    byTabId: {},
  }),
);

const entryFor = (tabId: string) => {
  let entry = demands.get(tabId);
  if (!entry) {
    entry = { ready: false, request: null, release: null, pending: new Set(), url: undefined };
    demands.set(tabId, entry);
  }
  return entry;
};

const startDemand = (entry: DesktopBrowserDemand) => {
  if (!entry.request || entry.release || entry.pending.size === 0) return;
  const release = entry.request(entry.url);
  if (entry.ready || entry.pending.size === 0) release();
  else entry.release = release;
};

const setFailure = (tabId: string, cause: unknown | null) =>
  useDesktopBrowserFailures.setState((state) => {
    const byTabId = { ...state.byTabId };
    if (cause === null) delete byTabId[tabId];
    else
      byTabId[tabId] =
        cause instanceof Error ? cause.message : "The browser preview could not be restored.";
    return { byTabId };
  });

export const useDesktopBrowserDemandFailure = (tabId: string | null) =>
  useDesktopBrowserFailures((state) => (tabId === null ? null : (state.byTabId[tabId] ?? null)));

/** UI retries and native automation join the same cold guest creation. */
export function ensureDesktopBrowserTab(tabId: string, url?: string): Promise<void> {
  const entry = entryFor(tabId);
  if (entry.ready) return Promise.resolve();
  if (url !== undefined && url !== entry.url) {
    for (const waiter of entry.pending)
      waiter.reject(new Error("Browser navigation was superseded."));
    entry.pending.clear();
    entry.release?.();
    entry.release = null;
  }
  if (url !== undefined || entry.pending.size === 0) entry.url = url;
  let waiter!: PendingDemand;
  const pending = new Promise<void>((resolve, reject) => {
    waiter = { resolve, reject };
  });
  entry.pending.add(waiter);
  const timer = setTimeout(() => {
    entry.pending.delete(waiter);
    const cause = new Error("The selected desktop did not restore its browser preview.");
    waiter.reject(cause);
    markDesktopBrowserTabUnavailable(tabId, cause);
    if (entry.pending.size === 0) {
      entry.release?.();
      entry.release = null;
    }
  }, 45_000);
  startDemand(entry);
  return pending.finally(() => clearTimeout(timer));
}

export function registerDesktopBrowserDemand(
  tabId: string,
  request: (url?: string) => () => void,
): () => void {
  const entry = entryFor(tabId);
  entry.request = request;
  startDemand(entry);
  return () => {
    if (entry.request !== request) return;
    markDesktopBrowserTabUnavailable(tabId);
    entry.request = null;
    entry.release?.();
    entry.release = null;
    for (const waiter of entry.pending) waiter.reject(new Error("The browser preview was closed."));
    entry.pending.clear();
    demands.delete(tabId);
    setFailure(tabId, null);
  };
}

export function markDesktopBrowserTabReady(tabId: string): void {
  const entry = demands.get(tabId);
  if (!entry) return;
  entry.ready = true;
  setFailure(tabId, null);
  for (const waiter of entry.pending) waiter.resolve();
  entry.pending.clear();
  entry.release?.();
  entry.release = null;
}

export function markDesktopBrowserTabUnavailable(tabId: string, cause?: unknown): void {
  const entry = demands.get(tabId);
  if (!entry) {
    if (cause !== undefined) setFailure(tabId, cause);
    return;
  }
  entry.ready = false;
  if (cause !== undefined) {
    setFailure(tabId, cause);
    for (const waiter of entry.pending) waiter.reject(cause);
    entry.pending.clear();
    entry.release?.();
    entry.release = null;
  }
}
