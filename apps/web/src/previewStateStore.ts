import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
/**
 * Per-thread preview UI state.
 *
 * Each thread owns an independent atom. Most consumers read exactly one
 * thread; the desktop browser host uses the aggregate session atom because it
 * is the one place that must enumerate every live preview tab.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  type DesktopPreviewColorScheme,
  type DesktopPreviewFavicon,
  type EnvironmentId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { PREVIEW_RECENT_URL_LIMIT } from "./components/preview/previewConstants";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { updateHandoffBrowserTitle } from "./handoffs/handoffsStore";
import { useRightPanelStore } from "./rightPanelStore";
import { randomUUID } from "./lib/utils";

const openFocusClientId = randomUUID();

/** Foreground requests reserve their selection order before recovery or RPC work starts. */
export function capturePreviewOpenFocus(
  ref: ScopedThreadRef,
  background = false,
): NonNullable<PreviewOpenInput["focus"]> {
  const panel = useRightPanelStore.getState();
  return {
    clientId: openFocusClientId,
    userActionRevision: background
      ? panel.getUserActionRevision(ref)
      : panel.recordSelectionIntent(ref),
  };
}

export interface DesktopPreviewOverlay {
  hasWebContents: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon: DesktopPreviewFavicon | null;
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  sessions: Record<string, PreviewSessionSnapshot>;
  /** Tabs intentionally closed by this client. Stale list snapshots must not resurrect them. */
  suppressedTabIds: ReadonlySet<string>;
  /** Tabs from the initial list; their historical creation events must not select them. */
  initialListTabIds: ReadonlySet<string>;
  /** Creation focus already applied, or superseded by an explicit selection. */
  handledOpenTabIds: ReadonlySet<string>;
  activeTabId: string | null;
  desktopOverlay: DesktopPreviewOverlay | null;
  desktopByTabId: Record<string, DesktopPreviewOverlay>;
  recentlySeenUrls: string[];
  /** Whether the first authoritative tab list has arrived. */
  listLoaded: boolean;
  /** Server process currently authoritative for revision ordering. */
  serverEpoch: string | null;
  /** Latest ordered server revision applied from a list response or event. */
  serverRevision: number;
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  sessions: {},
  suppressedTabIds: new Set<string>(),
  initialListTabIds: new Set<string>(),
  handledOpenTabIds: new Set<string>(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [] as string[],
  listLoaded: false,
  serverEpoch: null,
  serverRevision: 0,
});

const emptyPreviewStateAtom = Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
  Atom.withLabel("preview:empty-thread"),
);

export const previewStateAtom = Atom.family((threadKey: string) =>
  Atom.make<ThreadPreviewState>(EMPTY_THREAD_PREVIEW_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`preview:thread:${threadKey}`),
  ),
);

// Only the Electron browser host needs a cross-thread view. Keep that index
// separate so thread-local readers never subscribe to unrelated previews.
interface ActivePreviewThreadIndex {
  readonly keys: ReadonlySet<string>;
}

const activePreviewThreadKeysAtom = Atom.make<ActivePreviewThreadIndex>({
  keys: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-thread-keys"));

const activePreviewSessionsAtom = Atom.make((get) => {
  const byThreadKey: Record<string, ThreadPreviewState> = {};
  for (const threadKey of get(activePreviewThreadKeysAtom).keys) {
    const state = get(previewStateAtom(threadKey));
    if (Object.keys(state.sessions).length > 0) {
      byThreadKey[threadKey] = state;
    }
  }
  return byThreadKey;
}).pipe(Atom.withLabel("preview:active-sessions"));

const changedPreviewThreadKeys = new Set<string>();
const previewServerEpochs = new Map<EnvironmentId, string>();
const retiredPreviewServerEpochs = new Map<EnvironmentId, Set<string>>();

function syncActivePreviewThread(threadKey: string, state: ThreadPreviewState): void {
  const active = Object.keys(state.sessions).length > 0;
  appAtomRegistry.update(activePreviewThreadKeysAtom, (current) => {
    if (current.keys.has(threadKey) === active) return current;
    const next = new Set(current.keys);
    if (active) next.add(threadKey);
    else next.delete(threadKey);
    return { keys: next };
  });
}

function updateThreadPreviewState(
  ref: ScopedThreadRef,
  update: (current: ThreadPreviewState) => ThreadPreviewState,
): void {
  const threadKey = scopedThreadKey(ref);
  const atom = previewStateAtom(threadKey);
  let nextState = appAtomRegistry.get(atom);
  const previousSessions = nextState.sessions;
  const changed = appAtomRegistry.modify(atom, (current) => {
    nextState = update(current);
    return [nextState !== current, nextState];
  });
  if (!changed) return;
  for (const [tabId, snapshot] of Object.entries(nextState.sessions)) {
    const previous = previousSessions[tabId];
    if (previous === snapshot || previous?.navStatus === snapshot.navStatus) continue;
    if (snapshot.navStatus._tag === "Success" && snapshot.navStatus.title) {
      updateHandoffBrowserTitle(ref, tabId, snapshot.navStatus.title, snapshot.navStatus.url);
    }
  }
  changedPreviewThreadKeys.add(threadKey);
  syncActivePreviewThread(threadKey, nextState);
}

const dedupeRecentUrls = (existing: string[], url: string): string[] => {
  try {
    url = stripPreviewBootstrapTokenFromUrl(new URL(url)).href;
  } catch {
    /* Relative input is normalized by navigation. */
  }
  const next = [url, ...existing.filter((entry) => entry !== url)];
  return next.slice(0, PREVIEW_RECENT_URL_LIMIT);
};

const rememberSnapshotUrl = (
  recentlySeenUrls: string[],
  snapshot: PreviewSessionSnapshot,
): string[] =>
  snapshot.navStatus._tag === "Idle"
    ? recentlySeenUrls
    : dedupeRecentUrls(recentlySeenUrls, snapshot.navStatus.url);

const latestSnapshot = (
  sessions: Record<string, PreviewSessionSnapshot>,
): PreviewSessionSnapshot | null =>
  Object.values(sessions)
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1) ?? null;

const removeSession = (current: ThreadPreviewState, tabId: string): ThreadPreviewState => {
  if (!current.sessions[tabId]) return current;
  const { [tabId]: _closed, ...sessions } = current.sessions;
  const { [tabId]: _desktop, ...desktopByTabId } = current.desktopByTabId;
  const nextSnapshot = latestSnapshot(sessions);
  const activeTabId =
    current.activeTabId === tabId ? (nextSnapshot?.tabId ?? null) : current.activeTabId;
  const snapshot = activeTabId ? (sessions[activeTabId] ?? nextSnapshot) : nextSnapshot;
  return {
    ...current,
    sessions,
    initialListTabIds: new Set([...current.initialListTabIds].filter((id) => id !== tabId)),
    handledOpenTabIds: new Set([...current.handledOpenTabIds].filter((id) => id !== tabId)),
    desktopByTabId,
    activeTabId: snapshot?.tabId ?? null,
    snapshot,
    desktopOverlay: snapshot ? (desktopByTabId[snapshot.tabId] ?? null) : null,
  };
};

export function useThreadPreviewState(ref: ScopedThreadRef | null | undefined): ThreadPreviewState {
  const atom = ref ? previewStateAtom(scopedThreadKey(ref)) : emptyPreviewStateAtom;
  return useAtomValue(atom);
}

export function useActivePreviewSessions(): Record<string, ThreadPreviewState> {
  return useAtomValue(activePreviewSessionsAtom);
}

export function readThreadPreviewState(ref: ScopedThreadRef): ThreadPreviewState {
  return appAtomRegistry.get(previewStateAtom(scopedThreadKey(ref)));
}

/** A restarted primary server no longer owns the desktop pages from its previous epoch. */
export function resetPreviewServerEpoch(
  environmentId: EnvironmentId,
  serverEpoch: string,
): ScopedThreadRef[] {
  if (isRetiredPreviewServerEpoch(environmentId, serverEpoch)) return [];
  const retired = retiredPreviewServerEpochs.get(environmentId) ?? new Set<string>();
  const previousEpoch = previewServerEpochs.get(environmentId);
  if (previousEpoch !== undefined && previousEpoch !== serverEpoch) retired.add(previousEpoch);
  previewServerEpochs.set(environmentId, serverEpoch);
  retiredPreviewServerEpochs.set(environmentId, retired);
  const reset: ScopedThreadRef[] = [];
  for (const threadKey of changedPreviewThreadKeys) {
    const ref = parseScopedThreadKey(threadKey);
    if (!ref || ref.environmentId !== environmentId) continue;
    const current = readThreadPreviewState(ref);
    if (current.serverEpoch === null || current.serverEpoch === serverEpoch) continue;
    retired.add(current.serverEpoch);
    updateThreadPreviewState(ref, () => ({
      ...EMPTY_THREAD_PREVIEW_STATE,
      serverEpoch,
      recentlySeenUrls: current.recentlySeenUrls,
    }));
    reset.push(ref);
  }
  return reset;
}

/** Retired primary-server responses cannot recreate native pages after a restart. */
export function isRetiredPreviewServerEpoch(
  environmentId: EnvironmentId,
  serverEpoch: string,
): boolean {
  return retiredPreviewServerEpochs.get(environmentId)?.has(serverEpoch) ?? false;
}

/** Automation tabs stay hidden until revealed; user background tabs remain visible. */
export function hiddenPreviewTabIds(
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): Set<string> {
  return new Set(
    Object.values(sessions)
      .filter((session) => session.runtime === "server" && session.reveal === false)
      .map((session) => session.tabId),
  );
}

function applyOpenedFocus(
  current: ThreadPreviewState,
  event: Extract<PreviewEvent, { type: "opened" }>,
  superseded: boolean,
): ThreadPreviewState {
  const snapshot = current.sessions[event.tabId];
  if (!snapshot || current.handledOpenTabIds.has(event.tabId)) return current;
  const handledOpenTabIds = new Set(current.handledOpenTabIds).add(event.tabId);
  if (superseded || event.background === true || event.snapshot.reveal === false) {
    return { ...current, handledOpenTabIds };
  }
  return {
    ...current,
    handledOpenTabIds,
    activeTabId: event.tabId,
    snapshot,
    desktopOverlay: current.desktopByTabId[event.tabId] ?? null,
  };
}

export function applyPreviewServerEvent(ref: ScopedThreadRef, event: PreviewEvent): void {
  const previous = readThreadPreviewState(ref);
  const focusSuperseded =
    event.type === "opened" &&
    (event.focus?.clientId === openFocusClientId
      ? event.focus.userActionRevision !== useRightPanelStore.getState().getUserActionRevision(ref)
      : previous.initialListTabIds.has(event.tabId));
  updateThreadPreviewState(ref, (current) => {
    if (current.serverEpoch !== null && event.serverEpoch !== current.serverEpoch) return current;
    // A list may hydrate a new tab before its creation event. Consume that
    // event's focus once, while retaining newer metadata and revision ordering.
    if (event.revision < current.serverRevision) {
      return event.type === "opened" ? applyOpenedFocus(current, event, focusSuperseded) : current;
    }
    const next = (() => {
      switch (event.type) {
        case "opened":
        case "navigated":
        case "resized": {
          const snapshot = event.snapshot;
          if (current.suppressedTabIds.has(snapshot.tabId)) return current;
          const recentlySeenUrls =
            snapshot.navStatus._tag === "Idle"
              ? current.recentlySeenUrls
              : dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url);
          const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
          const activeTabId = current.activeTabId;
          const activeSnapshot = sessions[activeTabId ?? snapshot.tabId] ?? snapshot;
          const updated = {
            ...current,
            sessions,
            activeTabId: activeTabId ?? snapshot.tabId,
            snapshot: activeSnapshot,
            desktopOverlay: current.desktopByTabId[activeSnapshot.tabId] ?? null,
            recentlySeenUrls,
          };
          return event.type === "opened"
            ? applyOpenedFocus(updated, event, focusSuperseded)
            : updated;
        }
        case "failed": {
          const existing = current.sessions[event.tabId];
          if (!existing) return current;
          const failedSnapshot = {
            ...existing,
            navStatus: {
              _tag: "LoadFailed" as const,
              url: event.url,
              title: event.title,
              code: event.code,
              description: event.description,
              ...(event.download === undefined ? {} : { download: event.download }),
            },
            updatedAt: event.createdAt,
          };
          const sessions = { ...current.sessions, [event.tabId]: failedSnapshot };
          return {
            ...current,
            sessions,
            snapshot: current.activeTabId === event.tabId ? failedSnapshot : current.snapshot,
          };
        }
        case "closed": {
          const closed = removeSession(current, event.tabId);
          if (!closed.suppressedTabIds.has(event.tabId)) return closed;
          const suppressedTabIds = new Set(closed.suppressedTabIds);
          suppressedTabIds.delete(event.tabId);
          return { ...closed, suppressedTabIds };
        }
      }
    })();
    return next.serverRevision === event.revision && next.serverEpoch === event.serverEpoch
      ? next
      : {
          ...next,
          serverEpoch: event.serverEpoch,
          serverRevision: event.revision,
        };
  });
  const state = readThreadPreviewState(ref);
  if (
    event.type === "opened" &&
    !focusSuperseded &&
    !previous.handledOpenTabIds.has(event.tabId) &&
    state.handledOpenTabIds.has(event.tabId) &&
    event.background !== true &&
    event.snapshot.reveal !== false &&
    state.activeTabId === event.tabId
  ) {
    // PreviewPanel renders the right-panel surface's resource. Apply creation
    // focus here once; delayed React reconciliation must not replay it over a
    // later file, terminal, or browser selection.
    const panel = useRightPanelStore.getState();
    // Another client's accepted foreground open is a newer selection intent
    // here too. Local requests already recorded their intent before recovery.
    if (event.focus?.clientId !== openFocusClientId) panel.recordSelectionIntent(ref);
    panel.reconcileBrowserSurfaces(
      ref,
      Object.keys(state.sessions),
      hiddenPreviewTabIds(state.sessions),
      event.tabId,
    );
  }
}

export function applyPreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (!snapshot && current.snapshot === null) return current;
    if (!snapshot) {
      return {
        ...current,
        snapshot: null,
        sessions: {},
        initialListTabIds: new Set<string>(),
        handledOpenTabIds: new Set<string>(),
        activeTabId: null,
        desktopOverlay: null,
        desktopByTabId: {},
      };
    }
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const existing = current.sessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) return current;
    const recentlySeenUrls = rememberSnapshotUrl(current.recentlySeenUrls, snapshot);
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      handledOpenTabIds: new Set([
        ...current.handledOpenTabIds,
        ...Object.keys(current.sessions),
        snapshot.tabId,
      ]),
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

/**
 * Merge a server mutation without changing which tab the user is viewing.
 *
 * Commands such as resize can target background tabs. Their response is
 * authoritative for that tab, but it is not a request to focus the tab.
 * An open reply whose focus was superseded also consumes its creation intent.
 */
export function updatePreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot,
  options: { consumeOpenFocus?: boolean } = {},
): void {
  updateThreadPreviewState(ref, (current) => {
    if (current.suppressedTabIds.has(snapshot.tabId)) return current;
    const handledOpenTabIds =
      options.consumeOpenFocus && !current.handledOpenTabIds.has(snapshot.tabId)
        ? new Set(current.handledOpenTabIds).add(snapshot.tabId)
        : current.handledOpenTabIds;
    const existing = current.sessions[snapshot.tabId];
    if (existing && existing.updatedAt > snapshot.updatedAt) {
      return handledOpenTabIds === current.handledOpenTabIds
        ? current
        : { ...current, handledOpenTabIds };
    }
    const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
    const activeTabId =
      current.activeTabId && sessions[current.activeTabId] ? current.activeTabId : snapshot.tabId;
    const activeSnapshot = sessions[activeTabId] ?? snapshot;
    return {
      ...current,
      sessions,
      handledOpenTabIds,
      activeTabId,
      snapshot: activeSnapshot,
      desktopOverlay: current.desktopByTabId[activeTabId] ?? null,
      recentlySeenUrls: rememberSnapshotUrl(current.recentlySeenUrls, snapshot),
    };
  });
}

/** Reconcile one environment; return false if an event overtook its first authoritative list. */
export function reconcilePreviewEnvironmentSessions(
  environmentId: EnvironmentId,
  result: PreviewListResult,
): boolean {
  if (isRetiredPreviewServerEpoch(environmentId, result.serverEpoch)) return true;
  const sessionsByThread = new Map<ThreadId, PreviewSessionSnapshot[]>();
  for (const threadKey of changedPreviewThreadKeys) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref?.environmentId === environmentId) sessionsByThread.set(ref.threadId, []);
  }
  for (const snapshot of result.sessions) {
    const threadId = ThreadId.make(snapshot.threadId);
    const sessions = sessionsByThread.get(threadId) ?? [];
    sessions.push(snapshot);
    sessionsByThread.set(threadId, sessions);
  }
  let listLoaded = true;
  for (const [threadId, sessions] of sessionsByThread) {
    const ref = scopeThreadRef(environmentId, threadId);
    reconcilePreviewServerSessions(ref, {
      ...result,
      sessions,
    });
    if (!readThreadPreviewState(ref).listLoaded) listLoaded = false;
  }
  return listLoaded;
}

/**
 * Replace the local session index from an authoritative preview.list result.
 * Missing tabs are removed while the current active tab is preserved whenever
 * it still exists in the server result.
 */
export function reconcilePreviewServerSessions(
  ref: ScopedThreadRef,
  result: PreviewListResult,
): void {
  if (isRetiredPreviewServerEpoch(ref.environmentId, result.serverEpoch)) return;
  updateThreadPreviewState(ref, (current) => {
    const sameServer = current.serverEpoch === result.serverEpoch;
    if (sameServer && result.revision < current.serverRevision) {
      return current;
    }
    const snapshots = result.sessions;
    const sessions: Record<string, PreviewSessionSnapshot> = {};
    const currentSuppressedTabIds = sameServer ? current.suppressedTabIds : new Set<string>();
    let recentlySeenUrls = current.recentlySeenUrls;
    for (const snapshot of snapshots) {
      if (currentSuppressedTabIds.has(snapshot.tabId)) continue;
      const existing = sameServer ? current.sessions[snapshot.tabId] : undefined;
      const next = existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot;
      sessions[next.tabId] = next;
      recentlySeenUrls = rememberSnapshotUrl(recentlySeenUrls, next);
    }

    const fallback = latestSnapshot(sessions);
    const activeTabId =
      current.activeTabId && sessions[current.activeTabId]
        ? current.activeTabId
        : (fallback?.tabId ?? null);
    const snapshot = activeTabId ? (sessions[activeTabId] ?? null) : null;
    const desktopByTabId = sameServer
      ? Object.fromEntries(
          Object.entries(current.desktopByTabId).filter(([tabId]) => sessions[tabId] !== undefined),
        )
      : {};
    const suppressedTabIds = new Set(
      [...currentSuppressedTabIds].filter((tabId) =>
        snapshots.some((snapshot) => snapshot.tabId === tabId),
      ),
    );
    const handledOpenTabIds = new Set(
      [...(sameServer || current.serverEpoch === null ? current.handledOpenTabIds : [])].filter(
        (tabId) => sessions[tabId] !== undefined,
      ),
    );
    const initialListTabIds = new Set(
      [...(sameServer || current.serverEpoch === null ? current.initialListTabIds : [])].filter(
        (tabId) => sessions[tabId] !== undefined,
      ),
    );
    // Initial hydration suppresses historical events, not an open requested by
    // this client while the list was pending. Only applied or superseded focus
    // belongs in handledOpenTabIds, so that open's RPC can still select its tab.
    if (
      !current.listLoaded &&
      current.activeTabId === null &&
      Object.keys(current.sessions).length === 0
    ) {
      for (const tabId of Object.keys(sessions)) initialListTabIds.add(tabId);
    }
    return {
      ...current,
      sessions,
      suppressedTabIds,
      initialListTabIds,
      handledOpenTabIds,
      activeTabId,
      snapshot,
      desktopByTabId,
      desktopOverlay: activeTabId ? (desktopByTabId[activeTabId] ?? null) : null,
      recentlySeenUrls,
      listLoaded: true,
      serverEpoch: result.serverEpoch,
      serverRevision: result.revision,
    };
  });
}

function isPreviewStateEqual(
  previous: DesktopPreviewOverlay | null,
  next: DesktopPreviewOverlay | null,
) {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.hasWebContents === next.hasWebContents &&
      previous.canGoBack === next.canGoBack &&
      previous.canGoForward === next.canGoForward &&
      previous.loading === next.loading &&
      previous.zoomFactor === next.zoomFactor &&
      previous.pictureInPicture === next.pictureInPicture &&
      previous.colorScheme === next.colorScheme &&
      previous.audioMuted === next.audioMuted &&
      previous.audible === next.audible &&
      previous.controller === next.controller &&
      previous.favicon?.dataUrl === next.favicon?.dataUrl &&
      previous.favicon?.pageUrl === next.favicon?.pageUrl &&
      previous.favicon?.capturedAt === next.favicon?.capturedAt)
  );
}

export function applyPreviewDesktopState(
  ref: ScopedThreadRef,
  tabId: string,
  overlay: DesktopPreviewOverlay | null,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (isPreviewStateEqual(current.desktopByTabId[tabId] ?? null, overlay)) {
      return current;
    }
    const desktopByTabId = { ...current.desktopByTabId };
    if (overlay) desktopByTabId[tabId] = overlay;
    else delete desktopByTabId[tabId];
    return {
      ...current,
      desktopByTabId,
      desktopOverlay: current.activeTabId === tabId ? overlay : current.desktopOverlay,
    };
  });
}

export function beginPreviewSessionClose(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.add(tabId);
    return {
      ...removeSession(current, tabId),
      suppressedTabIds,
    };
  });
}

export function cancelPreviewSessionClose(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot | null,
  tabId: string,
): void {
  updateThreadPreviewState(ref, (current) => {
    if (!current.suppressedTabIds.has(tabId)) return current;
    const suppressedTabIds = new Set(current.suppressedTabIds);
    suppressedTabIds.delete(tabId);
    if (!snapshot) {
      return { ...current, suppressedTabIds };
    }
    const recentlySeenUrls =
      snapshot.navStatus._tag !== "Idle"
        ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
        : current.recentlySeenUrls;
    return {
      ...current,
      snapshot,
      sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
      suppressedTabIds,
      activeTabId: snapshot.tabId,
      desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
      recentlySeenUrls,
    };
  });
}

export function setActivePreviewTab(ref: ScopedThreadRef, tabId: string): void {
  updateThreadPreviewState(ref, (current) => {
    const snapshot = current.sessions[tabId];
    if (!snapshot) return current;
    const handledOpenTabIds = new Set([
      ...current.handledOpenTabIds,
      ...Object.keys(current.sessions),
    ]);
    if (
      current.activeTabId === tabId &&
      handledOpenTabIds.size === current.handledOpenTabIds.size
    ) {
      return current;
    }
    return {
      ...current,
      handledOpenTabIds,
      activeTabId: tabId,
      snapshot,
      desktopOverlay: current.desktopByTabId[tabId] ?? null,
    };
  });
}

/**
 * Runs `action` once the thread's preview state has the tab, which a popup's
 * `opened` event may deliver after the stream that announced it. Gives up
 * after `timeoutMs`. Returns a cancel function.
 */
export function whenPreviewTabKnown(
  ref: ScopedThreadRef,
  tabId: string,
  action: () => void,
  timeoutMs = 5_000,
): () => void {
  const atom = previewStateAtom(scopedThreadKey(ref));
  if (appAtomRegistry.get(atom).sessions[tabId]) {
    action();
    return () => {};
  }
  const stop = () => {
    clearTimeout(timer);
    unsubscribe();
  };
  const unsubscribe = appAtomRegistry.subscribe(atom, (state) => {
    if (!state.sessions[tabId]) return;
    stop();
    action();
  });
  const timer = setTimeout(stop, timeoutMs);
  return stop;
}

export function rememberPreviewUrl(ref: ScopedThreadRef, url: string): void {
  if (url.trim().length === 0) return;
  updateThreadPreviewState(ref, (current) => ({
    ...current,
    recentlySeenUrls: dedupeRecentUrls(current.recentlySeenUrls, url),
  }));
}

export function isPreviewSupportedInRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.desktopBridge?.preview);
}

/**
 * Forgets a deleted thread's previews. The server closes their sessions too,
 * but the desktop host keeps a page for every session held here.
 */
export function clearThreadPreviewState(ref: ScopedThreadRef): void {
  updateThreadPreviewState(ref, (current) =>
    Object.keys(current.sessions).length === 0 ? current : EMPTY_THREAD_PREVIEW_STATE,
  );
}

export function resetPreviewStateForTests(): void {
  for (const threadKey of changedPreviewThreadKeys) {
    appAtomRegistry.set(previewStateAtom(threadKey), EMPTY_THREAD_PREVIEW_STATE);
  }
  changedPreviewThreadKeys.clear();
  previewServerEpochs.clear();
  retiredPreviewServerEpochs.clear();
  appAtomRegistry.set(activePreviewThreadKeysAtom, { keys: new Set<string>() });
}

export const __testing = {
  EMPTY_THREAD_PREVIEW_STATE,
  RECENT_URL_LIMIT: PREVIEW_RECENT_URL_LIMIT,
};
