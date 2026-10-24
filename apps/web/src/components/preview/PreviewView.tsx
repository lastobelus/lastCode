import {
  hostedPreviewNavigationUrl,
  selectHostedPreview,
  type PreparedHostedPreview,
} from "@t3tools/client-runtime/preview-hosting";

import { openPreparedExternalUrl } from "~/browser/openPreparedExternalUrl";
import {
  completeHostedPreviewRefresh,
  useHostedPreviewRefresh,
} from "~/browser/hostedPreviewRefresh";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { previewStreamDownloadUrl } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type PreviewViewportSetting,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@t3tools/contracts";
import {
  normalizePreviewUrl,
  resolveAddressBarInput,
  previewPdfAssetUrl,
  resolveSearchUrlTemplate,
} from "@t3tools/shared/preview";
import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { getClientSettings } from "~/hooks/useSettings";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironmentSupportsServerBrowser } from "~/state/entities";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useThreadPreviewLeases } from "~/state/previewHosting";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { closePreviewSession } from "./closePreviewSession";
import { openPreviewSession } from "./openPreviewSession";
import { showPreviewPopup } from "./showPreviewPopup";
import { prepareHostedPreview } from "./previewHostingRecovery";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewFileNotShown, PreviewUnreachable } from "./PreviewUnreachable";
import {
  clearPreviewRecoveryRequest,
  requestPreviewRecovery,
  usePreviewRecoveryRequest,
} from "./previewRecoveryRequest";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { alternatePreviewRuntime, useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { cn } from "~/lib/utils";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  findActiveBrowserRecordingRuntimeTabId,
  isBrowserRecordingStartCancelledError,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";

function reportHostedPreviewFailure(cause: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Unable to restore preview",
      description: cause instanceof Error ? cause.message : String(cause),
    }),
  );
}

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

function previewProfileName(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

/** Resolves stream access only while a server tab shows a file it downloaded. */
function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: { readonly id: string; readonly fileName: string };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() =>
        void openPreparedExternalUrl(props.url, async () =>
          hostedPreviewNavigationUrl(await prepareHostedPreview(props.threadRef, props.url)),
        ).catch(() => undefined)
      }
    />
  );
}

export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const canSendAnnotation =
    useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
    Boolean(onSendAnnotation);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef<{ cancelled: boolean } | null>(null);
  const isMountedRef = useRef(true);
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const miniPlayerTabId = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayerTabId(state.byThreadKey, threadRef),
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const environmentHostname = environmentHttpBaseUrl
    ? new URL(environmentHttpBaseUrl).hostname
    : null;
  const open = useAtomCommand(previewEnvironment.open);
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const environmentLabel = useEnvironment(threadRef.environmentId)?.label ?? "the environment";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef.environmentId);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");
  const adjust = useAtomCommand(previewEnvironment.adjust, "preview appearance or zoom");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const requestedHostedRefresh = useHostedPreviewRefresh(threadRef, tabId);
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  // Server tabs stream unless this desktop owns their authoritative native backing page.
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const isServerTab = snapshot?.runtime === "server" && !nativeServerTab;
  const serverOwnsRendering = snapshot?.runtime === "server";
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const [serverAspectRatioLocked, setServerAspectRatioLocked] = useState(false);
  const serverBodyRef = useRef<HTMLDivElement | null>(null);
  const [serverToolbarWidth, setServerToolbarWidth] = useState(0);
  const serverToolbarShown =
    snapshot?.runtime === "server" && (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT)._tag !== "fill";
  useEffect(() => {
    const element = serverBodyRef.current;
    if (!element || !serverToolbarShown) return;
    return observeResize(element, ([entry]) =>
      setServerToolbarWidth(Math.max(1, Math.round(entry?.contentRect.width ?? 0))),
    );
  }, [serverToolbarShown]);
  const [serverControlledTabId, setServerControlledTabId] = useState<string | null>(null);
  const serverInputDisabled = isServerTab && serverControlledTabId !== runtimeTabId;
  const [serverFrameTabId, setServerFrameTabId] = useState<string | null>(null);
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const layoutZoomFactor = useBrowserLayoutZoomFactor(desktopOverlay?.zoomFactor ?? 1);
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const recoveryRequest = usePreviewRecoveryRequest(threadRef, url, tabId ?? undefined);
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const serverStreamPending =
    isServerTab && !showEmptyState && !isUnreachable && serverFrameTabId !== runtimeTabId;
  const controller = desktopOverlay?.controller ?? "none";
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  // Passing the snapshot's raw `undefined` through would reach the IPC layer
  // as "every profile".
  const activeProfileId = snapshot?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const activeProfileName = previewProfileName(browserDefaults.profiles, activeProfileId);
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const navUrl = navStatus._tag === "Success" ? navStatus.url : null;
  const navTitle = navStatus._tag === "Success" ? navStatus.title : null;
  const failedUrlsByTab = useRef(new Map<string, string>());
  const latestHistoryUrl = recentHistoryEntries[0]?.url;
  // Keyed on the ids rather than threadRef, which is recreated on every update.
  const { environmentId: threadEnvironmentId, threadId } = threadRef;
  useEffect(() => {
    if (!runtimeTabId) return;
    if (navStatus._tag === "LoadFailed") {
      failedUrlsByTab.current.set(runtimeTabId, navStatus.url);
      return;
    }
    if (navStatus._tag !== "Success") return;
    const owner = { environmentId: threadRef.environmentId, threadId: threadRef.threadId };
    const failedUrl = failedUrlsByTab.current.get(runtimeTabId);
    // A restored URL can redirect; the final destination is not the request key.
    if (failedUrl) clearPreviewRecoveryRequest(owner, failedUrl);
    clearPreviewRecoveryRequest(owner, navStatus.url);
    failedUrlsByTab.current.delete(runtimeTabId);
  }, [navStatus, runtimeTabId, threadRef.environmentId, threadRef.threadId]);
  useEffect(() => {
    if (!navUrl || !navTitle || !latestHistoryUrl) return;
    setTitleForThreadUrl(
      scopeThreadRef(threadEnvironmentId, threadId),
      navUrl,
      navTitle,
      environmentHostname,
    );
  }, [environmentHostname, latestHistoryUrl, navTitle, navUrl, threadEnvironmentId, threadId]);

  // Recovery must not override a newer address, tab, or environment.
  const navigationIdentity = JSON.stringify([runtimeTabId, url, environmentHttpBaseUrl]);
  const navigationSequence = useRef({ identity: navigationIdentity, value: 0 });
  useEffect(() => {
    if (navigationSequence.current.identity !== navigationIdentity) {
      navigationSequence.current = {
        identity: navigationIdentity,
        value: navigationSequence.current.value + 1,
      };
    }
    return () => {
      navigationSequence.current.value += 1;
    };
  }, [navigationIdentity]);

  const navigateToResolvedUrl = async (resolvedUrl: string) => {
    const sequence = ++navigationSequence.current.value;
    if (isServerTab && serverSurfaceRef.current) {
      if (serverInputDisabled) return false;
      const prepared = await prepareHostedPreview(threadRef, resolvedUrl);
      if (sequence !== navigationSequence.current.value) return false;
      serverSurfaceRef.current.navigate(hostedPreviewNavigationUrl(prepared, resolvedUrl));
      rememberPreviewUrl(threadRef, resolvedUrl);
      return true;
    }
    if (runtimeTabId && previewBridge) {
      const prepared = await prepareHostedPreview(threadRef, resolvedUrl);
      if (sequence !== navigationSequence.current.value) return false;
      // The bridge mirrors the resolved URL back to the server.
      await previewBridge.navigate(runtimeTabId, hostedPreviewNavigationUrl(prepared));
      rememberPreviewUrl(threadRef, prepared.url);
      return true;
    }
    const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add({
          type: "error",
          title: "Unable to open browser",
          description: error.message,
        });
      }
    }
    return result._tag === "Success";
  };

  const handleSubmitUrl = async (next: string) => {
    try {
      const resolved = resolveAddressBarInput(next, resolveSearchUrlTemplate(getClientSettings()));
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, resolved);
      }
    } catch {}
  };

  const handleOpenServerUrl = async (next: string) => {
    try {
      const resolved =
        isServerTab || !previewBridge
          ? normalizePreviewUrl(next)
          : resolveDiscoveredServerUrl(threadRef.environmentId, next);
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, next);
      }
    } catch {}
  };

  const adjustServerTab = async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
    if (!tabId) return;
    const result = await adjust({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId, ...change },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to change the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    updatePreviewServerSnapshot(threadRef, result.value);
  };

  const serverZoomFactor = snapshot?.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const stepServerZoom = (direction: -1 | 0 | 1) => {
    const index = PREVIEW_ZOOM_LEVELS.indexOf(serverZoomFactor);
    const next =
      direction === 0
        ? DEFAULT_PREVIEW_ZOOM_FACTOR
        : PREVIEW_ZOOM_LEVELS[
            Math.min(
              Math.max((index < 0 ? 7 : index) + direction, 0),
              PREVIEW_ZOOM_LEVELS.length - 1,
            )
          ]!;
    if (next !== serverZoomFactor) void adjustServerTab({ zoomFactor: next });
  };
  const hostedPreviews = useThreadPreviewLeases(threadRef);
  const managedHandoff = (() => {
    try {
      return selectHostedPreview(new URL(url), hostedPreviews) !== null;
    } catch {
      return false;
    }
  })();
  const hostingEnvironmentId = threadRef.environmentId;
  const hostingThreadId = threadRef.threadId;
  const refreshPreparedPreview = async (
    prepared: Pick<PreparedHostedPreview, "url" | "navigationUrl">,
  ): Promise<boolean> => {
    const destination = hostedPreviewNavigationUrl(prepared);
    if (isServerTab) {
      if (serverControlledTabId !== runtimeTabId) return false;
      const surface = serverSurfaceRef.current;
      return surface
        ? destination !== url
          ? surface.navigate(destination)
          : surface.reload()
        : false;
    }
    if (!previewBridge || !runtimeTabId) return false;
    if (destination !== url) await previewBridge.navigate(runtimeTabId, destination);
    else await previewBridge.refresh(runtimeTabId);
    return true;
  };
  const refreshRecoveredPreview = useEffectEvent(refreshPreparedPreview);
  const handleRefresh = () => {
    const sequence = ++navigationSequence.current.value;
    void prepareHostedPreview(
      { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
      url,
    )
      .then(async (prepared) => {
        if (sequence === navigationSequence.current.value)
          await refreshPreparedPreview(isServerTab ? { ...prepared, url } : prepared);
      })
      .catch((cause: unknown) => {
        if (sequence === navigationSequence.current.value) reportHostedPreviewFailure(cause);
      });
  };

  // Returning to a retained panel must wake its server even when the guest
  // still displays a cached successful page. Healthy pages keep unsaved state.
  const preparedVisibleTab = useRef<{
    key: string;
    recovery: Promise<PreparedHostedPreview>;
    navigation: Promise<PreparedHostedPreview> | null;
    dispatch: Promise<boolean> | null;
    completed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!visible) {
      if (preparedVisibleTab.current?.completed) preparedVisibleTab.current = null;
      return;
    }
    if (
      !runtimeTabId ||
      !url ||
      !environmentHttpBaseUrl ||
      (navStatus._tag === "LoadFailed" && !requestedHostedRefresh)
    )
      return;
    if (
      requestedHostedRefresh?.expectedUrl &&
      tabId &&
      stripPreviewBootstrapTokenFromUrl(new URL(url)).href !== requestedHostedRefresh.expectedUrl
    ) {
      completeHostedPreviewRefresh(
        { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
        tabId,
        requestedHostedRefresh.id,
      );
      return;
    }
    const destination = requestedHostedRefresh?.url ?? url;
    const key = JSON.stringify([
      runtimeTabId,
      destination,
      hostingEnvironmentId,
      hostingThreadId,
      environmentHttpBaseUrl,
      requestedHostedRefresh?.id,
    ]);
    const previous = preparedVisibleTab.current;
    const attempt =
      previous?.key === key
        ? previous
        : {
            key,
            recovery: prepareHostedPreview(
              { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
              destination,
              "resource",
            ),
            navigation: null,
            dispatch: null,
            completed: false,
          };
    preparedVisibleTab.current = attempt;
    if (attempt.completed) return;
    let cancelled = false;
    const sequence = navigationSequence.current.value;
    void attempt.recovery
      .then(async (prepared) => {
        if (cancelled || sequence !== navigationSequence.current.value) return;
        if (!prepared.restarted && !requestedHostedRefresh) {
          attempt.completed = true;
          return;
        }
        // Preparation can finish before the streamed viewer attaches. Do not mint
        // or consume a one-use credential until that viewer confirms control.
        if (isServerTab && serverControlledTabId !== runtimeTabId) return;
        if (attempt.navigation === null) {
          attempt.navigation = prepareHostedPreview(
            { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
            destination,
          );
        }
        const authenticated = await attempt.navigation;
        if (cancelled || sequence !== navigationSequence.current.value) return;
        if (attempt.dispatch === null) {
          attempt.dispatch = refreshRecoveredPreview(
            isServerTab ? { ...authenticated, url: destination } : authenticated,
          ).then((accepted) => {
            attempt.completed = accepted;
            if (accepted && requestedHostedRefresh && tabId) {
              completeHostedPreviewRefresh(
                { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
                tabId,
                requestedHostedRefresh.id,
              );
            }
            if (!accepted) {
              attempt.navigation = null;
              attempt.dispatch = null;
            }
            return accepted;
          });
        }
        await attempt.dispatch;
      })
      .catch((cause: unknown) => {
        if (!cancelled && sequence === navigationSequence.current.value) {
          attempt.completed = true;
          reportHostedPreviewFailure(cause);
        }
      });
    return () => {
      cancelled = true;
      // The server stays prepared, but an unsent one-use credential must not
      // survive a hidden panel or a disconnected viewer indefinitely.
      if (!attempt.dispatch && !attempt.completed) attempt.navigation = null;
    };
  }, [
    visible,
    runtimeTabId,
    tabId,
    url,
    hostingEnvironmentId,
    hostingThreadId,
    environmentHttpBaseUrl,
    navStatus._tag,
    isServerTab,
    serverControlledTabId,
    requestedHostedRefresh,
  ]);

  const hostingAttemptedByTab = useRef(
    new Map<
      string,
      {
        url: string;
        environmentUrl: string | null;
        recovery: ReturnType<typeof prepareHostedPreview>;
        dispatch: Promise<boolean> | null;
        watching: boolean;
        completed: boolean;
      }
    >(),
  );
  const navKind = navStatus._tag;
  const recoveryIdentity = JSON.stringify([
    runtimeTabId,
    url,
    hostingEnvironmentId,
    hostingThreadId,
    environmentHttpBaseUrl,
    navKind,
  ]);
  const [hostedRecovery, setHostedRecovery] = useState({
    identity: recoveryIdentity,
    completed: false,
  });
  if (hostedRecovery.identity !== recoveryIdentity) {
    setHostedRecovery({ identity: recoveryIdentity, completed: false });
  }
  const restoringHostedPreview =
    visible &&
    runtimeTabId !== null &&
    environmentHttpBaseUrl !== null &&
    !requestedHostedRefresh &&
    navKind === "LoadFailed" &&
    (!isServerTab || serverControlledTabId === runtimeTabId) &&
    hostedRecovery.identity === recoveryIdentity &&
    !hostedRecovery.completed;
  const finishHostedRecovery = useEffectEvent((identity: string) => {
    setHostedRecovery((current) =>
      current.identity === identity ? { ...current, completed: true } : current,
    );
  });
  useEffect(() => {
    if (!visible || !runtimeTabId || !environmentHttpBaseUrl || requestedHostedRefresh) return;
    if (navKind !== "LoadFailed") {
      if (navKind === "Success") hostingAttemptedByTab.current.delete(runtimeTabId);
      return;
    }
    if (isServerTab && serverControlledTabId !== runtimeTabId) return;
    const previous = hostingAttemptedByTab.current.get(runtimeTabId);
    const sameDestination =
      previous?.url === url && previous.environmentUrl === environmentHttpBaseUrl;
    if (sameDestination && previous.completed) {
      void previous.recovery.then(
        () => finishHostedRecovery(recoveryIdentity),
        () => finishHostedRecovery(recoveryIdentity),
      );
      return;
    }
    // Effect replay reattaches to pending recovery; completed failures wait for a
    // deliberate reload or a successful navigation before trying again.
    const attempt = sameDestination
      ? previous
      : {
          url,
          environmentUrl: environmentHttpBaseUrl,
          recovery: prepareHostedPreview(
            { environmentId: hostingEnvironmentId, threadId: hostingThreadId },
            url,
          ),
          dispatch: null,
          watching: false,
          completed: false,
        };
    hostingAttemptedByTab.current.set(runtimeTabId, attempt);
    attempt.watching = true;
    let cancelled = false;
    const sequence = navigationSequence.current.value;
    void attempt.recovery
      .then(async (prepared) => {
        if (cancelled || sequence !== navigationSequence.current.value) return;
        if (prepared.restored) {
          if (attempt.dispatch === null) {
            attempt.dispatch = refreshRecoveredPreview(
              isServerTab ? { ...prepared, url } : prepared,
            ).then((accepted) => {
              attempt.completed = accepted;
              if (!accepted) hostingAttemptedByTab.current.delete(runtimeTabId);
              return accepted;
            });
          }
          await attempt.dispatch;
        } else attempt.completed = true;
        if (!cancelled) finishHostedRecovery(recoveryIdentity);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        attempt.completed = true;
        finishHostedRecovery(recoveryIdentity);
        if (sequence === navigationSequence.current.value) reportHostedPreviewFailure(cause);
      });
    return () => {
      cancelled = true;
      attempt.watching = false;
      // Immediate effect replay may rejoin this request. Once nobody observes
      // it, discard any credential that never reached the browser.
      queueMicrotask(() => {
        if (
          !attempt.watching &&
          !attempt.dispatch &&
          !attempt.completed &&
          hostingAttemptedByTab.current.get(runtimeTabId) === attempt
        )
          hostingAttemptedByTab.current.delete(runtimeTabId);
      });
    };
  }, [
    isServerTab,
    navKind,
    url,
    runtimeTabId,
    hostingEnvironmentId,
    hostingThreadId,
    environmentHttpBaseUrl,
    serverControlledTabId,
    requestedHostedRefresh,
    visible,
    recoveryIdentity,
  ]);

  const handleZoomIn = () => {
    if (serverOwnsRendering) stepServerZoom(1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  };

  const handleZoomOut = () => {
    if (serverOwnsRendering) stepServerZoom(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  };

  const handleResetZoom = () => {
    if (serverOwnsRendering) stepServerZoom(0);
    else if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  };

  const handleViewportChange = async (nextViewport: PreviewViewportSetting) => {
    if (!tabId) return;
    const result = await resize({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId,
        viewport: nextViewport,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to resize browser viewport",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      throw error;
    }
    updatePreviewServerSnapshot(threadRef, result.value);
  };

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: isServerTab ? serverZoomFactor : layoutZoomFactor,
      }),
    ).catch(() => undefined);
  };

  const onViewportChange = useEffectEvent(handleViewportChange);
  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, (nextViewport) =>
      onViewportChange(nextViewport),
    );
  }, [runtimeTabId]);

  const handleBack = () => {
    if (isServerTab) serverSurfaceRef.current?.history(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  };

  const handleForward = () => {
    if (isServerTab) serverSurfaceRef.current?.history(1);
    else if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  };

  const handleOpenInBrowser = () => {
    if (!url) return;
    void openPreparedExternalUrl(url, async () =>
      hostedPreviewNavigationUrl(await prepareHostedPreview(threadRef, url)),
    ).catch(() => undefined);
  };

  const moveTarget = alternatePreviewRuntime(
    threadRef.environmentId,
    primaryEnvironmentId,
    serverBrowser,
    snapshot,
  );
  const moveLabel =
    moveTarget === "server" ? `Open in ${environmentLabel}'s browser` : "Open on this computer";
  const handleMoveTab = async () => {
    if (!moveTarget || !tabId || !snapshot) return;
    const result = await openPreviewSession({
      openPreview: open,
      threadRef,
      ...(url
        ? {
            url:
              moveTarget === "desktop"
                ? resolveDiscoveredServerUrl(threadRef.environmentId, url)
                : url,
          }
        : {}),
      viewport,
      ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
      runtime: moveTarget,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to move the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
    await closePreviewSession({ closePreview, snapshot, tabId, threadRef });
  };

  const handlePictureInPicture = () => {
    if (!tabId) return;
    if (miniPlayerTabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
    useRightPanelStore.getState().close(threadRef);
  };

  const desktopCall = (op: ((tabId: string) => Promise<void>) | undefined) => () => {
    if (op && runtimeTabId) void op(runtimeTabId).catch(() => undefined);
  };
  const moreMenuActions: PreviewMoreMenuActions | null = serverOwnsRendering
    ? {
        hardReload: () => void adjustServerTab({ hardReload: true }),
        setColorScheme: (colorScheme) => void adjustServerTab({ colorScheme }),
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        clearCookies: () => void adjustServerTab({ clear: "cookies" }),
        clearCache: () => void adjustServerTab({ clear: "cache" }),
        ...(nativeServerTab && previewBridge
          ? {
              openDevTools: desktopCall(previewBridge.openDevTools),
              toggleNativePictureInPicture: () => handleNativePictureInPicture(),
            }
          : {}),
      }
    : previewBridge
      ? {
          hardReload: desktopCall(previewBridge.hardReload),
          setColorScheme: (colorScheme) => {
            if (runtimeTabId)
              void previewBridge?.setColorScheme(runtimeTabId, colorScheme).catch(() => undefined);
          },
          zoomIn: handleZoomIn,
          zoomOut: handleZoomOut,
          resetZoom: handleResetZoom,
          clearCookies: () =>
            void previewBridge
              ?.clearCookies(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          clearCache: () =>
            void previewBridge
              ?.clearCache(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          openDevTools: desktopCall(previewBridge.openDevTools),
          toggleNativePictureInPicture: () => handleNativePictureInPicture(),
        }
      : null;

  const handleNativePictureInPicture = () => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  const handleCapture = (record: boolean) => {
    if (!previewBridge || !runtimeTabId || !tabId) return;
    const bridge = previewBridge;
    if (recordingRuntimeTabId) {
      void stopBrowserRecording(recordingRuntimeTabId).then(
        (artifact) => {
          if (!artifact) return;
          let pathCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "error",
                  title: "Unable to copy recording path",
                  description: "Clipboard API unavailable.",
                  actionProps: revealAction,
                }),
              );
              return;
            }

            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateRecordingToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateRecordingToast();
                }, 2_000);
              },
              (error) => {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: error instanceof Error ? error.message : "An error occurred.",
                    actionProps: revealAction,
                  }),
                );
              },
            );
          };

          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact(artifact.path),
          };
          const updateRecordingToast = () => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: pathCopied ? "Copied!" : "Copy path",
                    disabled: pathCopied,
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Recording saved",
              actionProps: revealAction,
              data: {
                secondaryActionProps: {
                  children: "Copy path",
                  onClick: copyPath,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to stop recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
      return;
    }
    if (record) {
      void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
        const description = error instanceof Error ? error.message : "An error occurred.";
        if (isBrowserRecordingStartCancelledError(error)) return;
        toastManager.add({
          type: "error",
          title: "Unable to start recording",
          description,
        });
      });
      return;
    }
    void bridge.captureScreenshot(runtimeTabId).then(
      (artifact) => {
        const revealAction = {
          children: revealInFileExplorerLabel(navigator.platform),
          onClick: () => void bridge.revealArtifact(artifact.path),
        };
        let pathCopied = false;
        let imageCopied = false;
        let toastId: ReturnType<typeof toastManager.add>;

        const updateScreenshotToast = (
          type: "success" | "error" = "success",
          title = "Screenshot saved",
          description?: string,
        ) => {
          toastManager.update(
            toastId,
            stackedThreadToast({
              type,
              title,
              description,
              actionProps: {
                children: imageCopied ? "Copied!" : "Copy image",
                disabled: imageCopied,
                onClick: copyImage,
              },
              data: {
                additionalActions: [
                  {
                    id: "copy-path",
                    props: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                  },
                ],
                secondaryActionProps: {
                  ...revealAction,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        };

        const copyPath = () => {
          if (!navigator.clipboard?.writeText) {
            updateScreenshotToast(
              "error",
              "Unable to copy screenshot path",
              "Clipboard API unavailable.",
            );
            return;
          }

          void navigator.clipboard.writeText(artifact.path).then(
            () => {
              pathCopied = true;
              updateScreenshotToast();
              window.setTimeout(() => {
                pathCopied = false;
                updateScreenshotToast();
              }, 2_000);
            },
            (error) => {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                error instanceof Error ? error.message : "An error occurred.",
              );
            },
          );
        };

        const copyImage = () => {
          void bridge.copyArtifactToClipboard(artifact.path).then(
            () => {
              imageCopied = true;
              updateScreenshotToast();
              window.setTimeout(() => {
                imageCopied = false;
                updateScreenshotToast();
              }, 2_000);
            },
            (error) => {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot",
                error instanceof Error ? error.message : "An error occurred.",
              );
            },
          );
        };

        toastId = toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Screenshot saved",
            actionProps: {
              children: "Copy image",
              onClick: copyImage,
            },
            data: {
              additionalActions: [
                {
                  id: "copy-path",
                  props: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                },
              ],
              secondaryActionProps: {
                ...revealAction,
              },
              secondaryActionVariant: "outline",
            },
          }),
        );
      },
      (error) => {
        toastManager.add({
          type: "error",
          title: "Unable to capture screenshot",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  };

  const handlePickElement = () => {
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      pickActiveRef.current.cancelled = true;
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat composer
    // textarea or the chrome-row pick button) BEFORE main steals focus into the
    // guest webContents.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const pickRequest = { cancelled: false };
    let submitted = false;
    pickActiveRef.current = pickRequest;
    setPickActive(true);
    const finishPick = () => {
      const isCurrentPick = pickActiveRef.current === pickRequest;
      if (isCurrentPick) {
        pickActiveRef.current = null;
        if (isMountedRef.current) setPickActive(false);
      }
      if (
        (isCurrentPick || submitted) &&
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {}
      }
    };
    // A failed pick is dropped silently; finishPick still releases the picker.
    const bridge = previewBridge;
    void settlePromise(async () => {
      await bridge.setAnnotationSendEnabled?.(
        runtimeTabId,
        Boolean(onSendAnnotation) &&
          readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
      );
      if (pickRequest.cancelled) return;
      const result = await bridge.pickElement(runtimeTabId);
      if (!result || pickRequest.cancelled) return;
      // Nothing that happens after this point (a second picker click, a tab
      // change, unmount) may discard it, so the pick stops being cancellable
      // here rather than in finishPick.
      if (pickActiveRef.current === pickRequest) {
        pickActiveRef.current = null;
        if (isMountedRef.current) setPickActive(false);
        submitted = true;
      }
      const { annotation: picked, submission, screenshotFailed = false } = result;
      // The structured annotation is still sendable when its optional crop
      // stalls or fails, so tell the user what they lost and keep going
      // instead of holding the composer for an attachment that never lands.
      // The stored copy drops the screenshot on failure, otherwise the prompt
      // would tell the agent a crop is attached when none was sent.
      const capture = await capturePreviewAnnotationScreenshot(picked);
      const cropDropped = screenshotFailed || capture.status === "failed";
      const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
      addPreviewAnnotation(threadRef, annotation);
      if (cropDropped) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not capture the picked element",
            description: "The annotation was kept without the screenshot.",
          }),
        );
      }
      const screenshotFile = capture.status === "captured" ? capture.file : null;
      const image =
        screenshotFile && annotation.screenshot
          ? ({
              type: "image",
              id: annotation.id,
              name: screenshotFile.name,
              mimeType: screenshotFile.type,
              sizeBytes: screenshotFile.size,
              previewUrl: annotation.screenshot.dataUrl,
              file: screenshotFile,
            } satisfies ComposerImageAttachment)
          : null;
      if (image) {
        addImage(threadRef, image);
      }
      if (
        submission === "send" &&
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        onSendAnnotation?.(annotation, image);
      }
    }).then(finishPick);
  };

  useEffect(() => {
    if (!pickActive || !previewBridge || !runtimeTabId) return;
    void previewBridge
      .setAnnotationSendEnabled?.(runtimeTabId, canSendAnnotation)
      .catch(() => undefined);
  }, [canSendAnnotation, pickActive, runtimeTabId]);

  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current.cancelled = true;
      pickActiveRef.current = null;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  const onPreviewAction = useEffectEvent(
    (action: Parameters<Parameters<typeof subscribePreviewAction>[0]>[0]) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    },
  );
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => onPreviewAction(action));
  }, [visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading || serverStreamPending}
        canGoBack={canGoBack && !serverInputDisabled}
        canGoForward={canGoForward && !serverInputDisabled}
        refreshDisabled={refreshDisabled || serverInputDisabled}
        inputDisabled={serverInputDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onCapture={previewBridge && tabId && !isServerTab ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPictureInPicture={
          tabId && (isServerTab || previewBridge) ? handlePictureInPicture : undefined
        }
        pictureInPicture={miniPlayerTabId === tabId}
        pictureInPictureDisabled={
          isUnreachable || (!isServerTab && !desktopOverlay?.hasWebContents)
        }
        onPickElement={previewBridge && tabId && !isServerTab ? handlePickElement : undefined}
        pickActive={pickActive}
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load. Pick is unavailable until the page renders" : undefined
        }
        leadingActions={
          activeProfileId !== browserDefaults.profileId ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" className="max-w-28 shrink-0" />}>
                <span className="truncate">{activeProfileName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeProfileName}</TooltipPopup>
            </Tooltip>
          ) : null
        }
        trailingActions={
          moreMenuActions ? (
            <PreviewMoreMenu
              enabled={
                runtimeTabId !== null &&
                (serverOwnsRendering || (desktopOverlay?.hasWebContents ?? false))
              }
              actions={moreMenuActions}
              {...(moveTarget
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
              profileName={activeProfileName}
              zoomFactor={
                serverOwnsRendering ? serverZoomFactor : (desktopOverlay?.zoomFactor ?? 1)
              }
              colorScheme={
                serverOwnsRendering
                  ? (snapshot?.colorScheme ?? "system")
                  : (desktopOverlay?.colorScheme ?? "system")
              }
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
            />
          ) : null
        }
      />

      <div ref={serverBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && isServerTab ? (
          <>
            {viewport._tag !== "fill" && !showEmptyState && !isUnreachable ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <BrowserDeviceToolbar
                  setting={viewport}
                  width={serverToolbarWidth}
                  aspectRatio={serverAspectRatioLocked ? viewport.width / viewport.height : null}
                  onAspectRatioChange={(ratio) => setServerAspectRatioLocked(ratio !== null)}
                  onChange={(setting) => commitBrowserViewportChange(runtimeTabId, setting)}
                />
              </div>
            ) : null}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ top: viewport._tag !== "fill" ? BROWSER_DEVICE_TOOLBAR_HEIGHT : 0 }}
            >
              <ServerBrowserSurface
                key={runtimeTabId}
                ref={serverSurfaceRef}
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                tabId={snapshot.tabId}
                pdfUrl={
                  navStatus._tag === "Success"
                    ? previewPdfAssetUrl(url, environmentHttpBaseUrl)
                    : null
                }
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControlledTabId(
                    control?.controller === "you" && control.canOperate ? runtimeTabId : null,
                  )
                }
                onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "panel")}
                // Stays connected under the empty state so a URL picked there reaches the page.
                className={cn(
                  "absolute inset-0 h-full w-full",
                  (showEmptyState || isUnreachable) && "invisible",
                )}
              />
            </div>
          </>
        ) : runtimeTabId && snapshot && !showEmptyState ? (
          previewBridge ? (
            <BrowserSurfaceSlot
              key={runtimeTabId}
              tabId={runtimeTabId}
              visible={visible && !isUnreachable}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                This tab is open in the T3 Code desktop app.
              </p>
            </div>
          )
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {runtimeTabId &&
        desktopOverlay &&
        !showEmptyState &&
        !isUnreachable &&
        !activeRecordingTabIds.has(runtimeTabId) ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={layoutZoomFactor}
            controller={controller}
          />
        ) : null}
        {navStatus._tag === "LoadFailed" && navStatus.download ? (
          <div className="absolute inset-0 z-10 bg-background">
            <ServerTabFileNotShown
              threadRef={threadRef}
              tabId={snapshot?.tabId ?? ""}
              url={navStatus.url}
              download={navStatus.download}
            />
          </div>
        ) : navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              managedHandoff={managedHandoff}
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
              {...(moveTarget === "server"
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
              recoveryRequest={recoveryRequest}
              restoringHostedPreview={restoringHostedPreview}
              onRequestRecovery={() => {
                void requestPreviewRecovery({
                  threadRef,
                  url: navStatus.url,
                  code: navStatus.code,
                  description: navStatus.description,
                  title: navStatus.title,
                  ...(tabId ? { tabId } : {}),
                });
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
