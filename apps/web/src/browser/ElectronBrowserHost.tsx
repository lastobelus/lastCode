import { DesktopCdpRelay } from "./DesktopCdpRelay";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewOpenLinkEvent,
  type DesktopBrowserRendererRequest,
  FILL_PREVIEW_VIEWPORT,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { type ComponentProps, useEffect, useEffectEvent, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { toastManager } from "~/components/ui/toast";

import { isElectron } from "~/env";
import { randomUUID } from "~/lib/utils";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import { useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentHasLocalDesktopBrowser } from "~/state/entities";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { useDesktopBrowserSessions } from "./useDesktopBrowserSessions";
import { acquireBrowserSurfaceActivity, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useActiveBrowserRecordingTabIds } from "./browserRecording";
import { prepareHostedPreview } from "~/components/preview/previewHostingRecovery";
import { hostedPreviewNavigationUrl } from "@t3tools/client-runtime/preview-hosting";
import { withDesktopTab } from "./desktopTabLifetime";
import { getDesktopBrowserHostId } from "./desktopBrowserTransport";
import {
  ensureDesktopBrowserTab,
  registerDesktopBrowserDemand,
  markDesktopBrowserTabUnavailable,
} from "./desktopBrowserDemand";

function reportLinkOpenFailure(cause: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not open the link in the browser",
    description: cause instanceof Error ? cause.message : undefined,
  });
}

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const hasLocalDesktopBrowser = useEnvironmentHasLocalDesktopBrowser(primaryEnvironmentId);
  useDesktopBrowserSessions(primaryEnvironmentId);
  useEffect(() => {
    if (
      primaryEnvironmentId === null ||
      hasLocalDesktopBrowser !== true ||
      !window.desktopBridge?.preview
    )
      return;
    void window.desktopBridge.preview
      .bindBrowserEnvironment({
        desktopHostId: "local",
        environmentId: primaryEnvironmentId,
      })
      .catch((cause) => console.error("Native browser environment binding failed", cause));
  }, [primaryEnvironmentId, hasLocalDesktopBrowser]);
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            desktopHostId:
              snapshot.desktopHostId ??
              (threadRef.environmentId === primaryEnvironmentId
                ? "local"
                : getDesktopBrowserHostId(threadRef.environmentId)),
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  const sessions = activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );
  const visibleTabIds = useBrowserSurfaceStore(
    useShallow((state) =>
      Object.entries(state.byTabId)
        .filter(([, surface]) => surface.visible && surface.rect !== null)
        .map(([id]) => id),
    ),
  );
  const activeTabIds = useBrowserSurfaceStore(
    useShallow((state) => Object.keys(state.activityByTabId)),
  );
  const recordingTabIds = useActiveBrowserRecordingTabIds();
  const [windowVisible, setWindowVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = () => setWindowVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const [mountedTabIds, setMountedTabIds] = useState<ReadonlySet<string>>(() => new Set());
  const [generations, setGenerations] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [requestedSources, setRequestedSources] = useState<
    ReadonlyMap<string, { readonly url: string; readonly previousUrl: string | null }>
  >(() => new Map());
  const demandRegistrations = useRef(new Map<string, () => void>());
  const requestGuest = useEffectEvent((id: string, url?: string) => {
    const release = acquireBrowserSurfaceActivity(id);
    if (url !== undefined) {
      const session = sessions.find((candidate) => candidate.runtimeTabId === id);
      const previousUrl =
        session?.snapshot.navStatus._tag === "Idle"
          ? null
          : (session?.snapshot.navStatus.url ?? null);
      setRequestedSources((previous) => new Map(previous).set(id, { url, previousUrl }));
    }
    setGenerations((previous) => new Map(previous).set(id, (previous.get(id) ?? 0) + 1));
    setMountedTabIds((previous) => new Set(previous).add(id));
    return release;
  });
  useEffect(() => {
    const current = demandRegistrations.current;
    const ids = new Set(sessions.map((session) => session.runtimeTabId));
    for (const [id, dispose] of current)
      if (!ids.has(id)) {
        dispose();
        current.delete(id);
      }
    for (const id of ids)
      if (!current.has(id))
        current.set(
          id,
          registerDesktopBrowserDemand(id, (url) => requestGuest(id, url)),
        );
  }, [sessions]);

  useEffect(() => {
    const obsolete = [...requestedSources].filter(([id, requested]) => {
      const session = sessions.find((candidate) => candidate.runtimeTabId === id);
      const url =
        session?.snapshot.navStatus._tag === "Idle"
          ? null
          : (session?.snapshot.navStatus.url ?? null);
      return !session || url !== requested.previousUrl;
    });
    if (obsolete.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Canonical navigation commits retire the temporary cold-navigation destination.
    setRequestedSources((current) => {
      const next = new Map(current);
      for (const [id] of obsolete) next.delete(id);
      return next;
    });
  }, [sessions, requestedSources]);
  useEffect(() => {
    const current = demandRegistrations.current;
    return () => {
      for (const dispose of current.values()) dispose();
      current.clear();
    };
  }, []);
  const [wakeRequests, setWakeRequests] = useState<
    ReadonlyMap<string, DesktopBrowserRendererRequest>
  >(() => new Map());
  const wakeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const receiveRendererRequest = useEffectEvent((request: DesktopBrowserRendererRequest) => {
    const key = JSON.stringify([request.environmentId, request.threadId, request.tabId]);
    const matches = sessions.filter(
      (session) =>
        session.threadRef.environmentId === request.environmentId &&
        session.threadRef.threadId === request.threadId &&
        session.snapshot.tabId === request.tabId &&
        session.desktopHostId === request.desktopHostId,
    );
    if (request.action === "unload") {
      for (const session of matches) markDesktopBrowserTabUnavailable(session.runtimeTabId);
      setMountedTabIds(
        (current) =>
          new Set(
            [...current].filter((id) => !matches.some((session) => session.runtimeTabId === id)),
          ),
      );
      return;
    }
    clearTimeout(wakeTimers.current.get(key));
    setWakeRequests((current) => new Map(current).set(key, request));
    wakeTimers.current.set(
      key,
      setTimeout(() => {
        wakeTimers.current.delete(key);
        setWakeRequests((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }, 45_000),
    );
  });
  useEffect(() => {
    const unsubscribe =
      window.desktopBridge?.preview?.onBrowserRendererRequest?.(receiveRendererRequest);
    const timers = wakeTimers.current;
    return () => {
      unsubscribe?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    const matches = sessions.filter((session) => {
      const request = wakeRequests.get(
        JSON.stringify([
          session.threadRef.environmentId,
          session.threadRef.threadId,
          session.snapshot.tabId,
        ]),
      );
      return request && session.desktopHostId === request.desktopHostId;
    });
    for (const session of matches)
      void ensureDesktopBrowserTab(session.runtimeTabId).catch(reportLinkOpenFailure);
  }, [sessions, wakeRequests]);
  const demandedTabIds = new Set([
    ...(windowVisible ? visibleTabIds : []),
    ...activeTabIds,
    ...recordingTabIds,
    ...sessions
      .filter((session) => session.pictureInPicture)
      .map((session) => session.runtimeTabId),
  ]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Surface leases admit guests to the external Electron cache; inactive guests retain their DOM.
    setMountedTabIds((current) => {
      const next = new Set(
        sessions
          .filter(
            (session) =>
              current.has(session.runtimeTabId) || demandedTabIds.has(session.runtimeTabId),
          )
          .map((session) => session.runtimeTabId),
      );
      return next.size === current.size && [...next].every((id) => current.has(id))
        ? current
        : next;
    });
  }, [sessions, demandedTabIds]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const onOpenLink = useEffectEvent(({ tabId, url, background }: DesktopPreviewOpenLinkEvent) => {
    const source = sessions.find((session) => session.runtimeTabId === tabId);
    if (!source) return;
    void openUrlInPreview({
      threadRef: source.threadRef,
      url,
      openPreview,
      profileId: source.snapshot.profileId,
      background,
    })
      .then((result) => {
        if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause)) {
          reportLinkOpenFailure(Cause.squash(result.cause));
        }
      })
      .catch(reportLinkOpenFailure);
  });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(onOpenLink);
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      <DesktopCdpRelay />
      {sessions.map(
        ({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor, desktopHostId }) => {
          if (!mountedTabIds.has(runtimeTabId)) return null;
          const canonicalUrl = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
          const requested = requestedSources.get(runtimeTabId);
          const url = requested?.previousUrl === canonicalUrl ? requested.url : canonicalUrl;
          return (
            <AuthorizedBrowserWebview
              key={`${runtimeTabId}:${generations.get(runtimeTabId) ?? 0}`}
              threadRef={threadRef}
              tabId={snapshot.tabId}
              runtimeTabId={runtimeTabId}
              initialUrl={url}
              viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
              pictureInPicture={pictureInPicture}
              profileId={snapshot.profileId}
              zoomFactor={zoomFactor}
              serverDriven={snapshot.runtime === "server"}
              desktopHostId={desktopHostId}
              demanded={demandedTabIds.has(runtimeTabId)}
              {...(snapshot.runtime === "server"
                ? {
                    serverRendering: {
                      colorScheme: snapshot.colorScheme ?? "system",
                      zoomFactor: snapshot.zoomFactor ?? 1,
                    },
                  }
                : {})}
            />
          );
        },
      )}
    </div>
  );
}

function AuthorizedBrowserWebview(
  props: ComponentProps<typeof HostedBrowserWebview> & { readonly demanded: boolean },
) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <PreparedBrowserWebview {...props} profileId={profileId} /> : null;
}

function PreparedBrowserWebview({
  demanded,
  ...props
}: ComponentProps<typeof HostedBrowserWebview> & { readonly demanded: boolean }) {
  const setHostingActivity = useAtomCommand(previewEnvironment.hostingActivity, {
    reportFailure: false,
  });
  const updateActivity = useEffectEvent(
    async (command: Parameters<typeof setHostingActivity>[0]) => {
      const result = await setHostingActivity(command);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  );
  const [source, setSource] = useState<{
    readonly url: string | null;
    readonly runId: string | undefined;
  } | null>(null);
  const prepare = useEffectEvent(async (url: string | null) => {
    if (url === null)
      return {
        url: null,
        restarted: false,
        runId: undefined,
        cold: source === null,
        sameUrl: true,
      };
    const prepared = await prepareHostedPreview(
      props.threadRef,
      url,
      source === null ? "navigation" : "resource",
    );
    const restarted =
      prepared.runId !== undefined ? prepared.runId !== source?.runId : prepared.restarted === true;
    const navigation =
      source !== null && restarted
        ? await prepareHostedPreview(props.threadRef, url, "navigation")
        : prepared;
    const navigationUrl = hostedPreviewNavigationUrl(navigation);
    return {
      url: navigationUrl,
      restarted,
      runId: navigation.runId,
      cold: source === null,
      sameUrl: navigationUrl === url,
    };
  });
  useEffect(() => {
    if (!demanded) return;
    let disposed = false;
    const command = {
      environmentId: props.threadRef.environmentId,
      input: {
        activityId: randomUUID(),
        threadId: props.threadRef.threadId,
        url: props.initialUrl ?? "about:blank",
        active: true,
      },
    };
    const acknowledged = updateActivity(command);
    void acknowledged
      .then(() => (disposed ? undefined : prepare(props.initialUrl)))
      .then((prepared) => {
        if (disposed || prepared === undefined) return;
        setSource((current) => current ?? { url: prepared.url, runId: prepared.runId });
        if (!prepared.cold && prepared.restarted && prepared.url !== null) {
          const bridge = window.desktopBridge?.preview;
          if (bridge)
            withDesktopTab(props.runtimeTabId, async () => {
              if (prepared.sameUrl) await bridge.refresh(props.runtimeTabId);
              else await bridge.navigate(props.runtimeTabId, prepared.url!);
              if (!disposed)
                setSource((current) =>
                  current === null ? null : { ...current, runId: prepared.runId },
                );
            });
        }
      })
      .catch((cause) => {
        if (disposed) return;
        markDesktopBrowserTabUnavailable(props.runtimeTabId, cause);
        reportLinkOpenFailure(cause);
      });
    return () => {
      disposed = true;
      void acknowledged
        .catch(() => undefined)
        .then(() => updateActivity({ ...command, input: { ...command.input, active: false } }))
        .catch(() => undefined);
    };
  }, [
    demanded,
    props.runtimeTabId,
    props.initialUrl,
    props.threadRef.environmentId,
    props.threadRef.threadId,
  ]);
  return source === null ? null : <HostedBrowserWebview {...props} initialUrl={source.url} />;
}

// Latch after hydration: Electron fixes the partition when the guest attaches.
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
