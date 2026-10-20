import type { DesktopBridge, DesktopLocalBuildFailure, DesktopUpdateState } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  formatLocalBuildFailureError,
  formatLocalBuildFailureDetails,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateProgressPercent,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  type DesktopUpdateStatusIconState,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import type { UpdateEverythingRun, UpdateRunLocalState } from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  useUpdateEverythingRun,
} from "./updateEverythingRun";
import { type ReportLocalUpdateError, useUpdateEverything } from "./useUpdateEverything";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  showsEverything,
  run,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly showsEverything: boolean;
  readonly run: UpdateEverythingRun | null;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || showsEverything || run !== null || isDownloading;
  const iconStatus: DesktopUpdateStatusIconState = showCheckIcon
    ? "checking"
    : isDownloading
      ? "downloading"
      : run !== null
        ? run.localVersion !== null && action === "install"
          ? "downloaded"
          : "everything"
        : showsEverything
          ? "everything"
          : action === "install"
            ? "downloaded"
            : action === "download"
              ? "available"
              : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function resolveSidebarUpdateButtonToneClassName({
  hasLocalBuildFailure,
  isInteractionDisabled,
  showUpdateIconState,
}: {
  readonly hasLocalBuildFailure: boolean;
  readonly isInteractionDisabled: boolean;
  readonly showUpdateIconState: boolean;
}): string {
  if (hasLocalBuildFailure) {
    return cn(
      "bg-destructive/12 text-destructive ring-destructive/40",
      !isInteractionDisabled && "hover:bg-destructive/18",
    );
  }
  if (showUpdateIconState) {
    return cn(
      "bg-update-surface text-update-foreground ring-update/40",
      !isInteractionDisabled && "hover:bg-update/18",
    );
  }
  return cn(
    "text-(--sidebar-icon-color)",
    !isInteractionDisabled && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

export function SidebarLocalBuildFailurePopover({
  failure,
  isCopied,
  onCopy,
}: {
  readonly failure: DesktopLocalBuildFailure;
  readonly isCopied: boolean;
  readonly onCopy: () => void;
}) {
  return (
    <div className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-1 text-left" role="alert">
      <div>
        <div className="text-sm leading-5 font-semibold text-destructive-foreground">
          Local build failed
        </div>
        <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
          {failure.phase} · {failure.percent}% est.
        </div>
      </div>
      <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-4 text-popover-foreground/90">
        {formatLocalBuildFailureError(failure.error)}
      </p>
      <div className="flex items-center justify-between gap-3 border-t border-destructive/20 pt-2">
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
          {failure.targetVersion}
        </span>
        <Button
          aria-label={
            isCopied ? "Local build failure details copied" : "Copy local build failure details"
          }
          className="shrink-0"
          onClick={onCopy}
          size="compact"
          variant="destructive-outline"
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy details"}
        </Button>
      </div>
    </div>
  );
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

async function downloadLocalUpdate(
  bridge: DesktopBridge,
  {
    notifyDownloaded,
    isLocalBuild,
    reportError = toastUpdateError,
  }: { readonly notifyDownloaded: boolean; readonly isLocalBuild: boolean; readonly reportError?: ReportLocalUpdateError },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) reportError(isLocalBuild ? "Could not build local nightly" : "Could not download update", actionError);
    return result.completed;
  } catch (error) {
    reportError(
      isLocalBuild ? "Could not start local nightly build" : "Could not start update download",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

async function installLocalUpdate(
  bridge: DesktopBridge,
  reportError: ReportLocalUpdateError = toastUpdateError,
): Promise<boolean> {
  try {
    const result = await bridge.installUpdate();
    if (!result.accepted) {
      showDesktopUpdateDownloadedToast(bridge, result.state);
      return false;
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (!actionError) return true;
    reportError("Could not install update", actionError);
    return false;
  } catch (error) {
    reportError(
      "Could not install update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}

export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [isActionPending, setIsActionPending] = useState(false);
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "local build failure details",
    timeout: 1_500,
    onCopy: () => {
      toastManager.add({ type: "success", title: "Build failure details copied" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy build failure details",
        description: error.message,
      });
    },
  });

  const updateStatus = state?.status;
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && updateStatus === "checking",
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, updateStatus });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.updateStatus !== updateStatus
  ) {
    setLatchInputs({ prefersReducedMotion, updateStatus });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (updateStatus === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }

  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const isDownloading = state?.status === "downloading";
  const localUpdateVersion =
    state && action !== "none" ? getDesktopUpdateDownloadedVersion(state) : null;
  const everything = useUpdateEverything(localUpdateVersion);
  const runsEverything = everything.hasUpdates && !isDownloading;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    showsEverything: runsEverything,
    run,
    isDownloading,
    showCheckIcon,
  });
  const idleTooltip =
    !showUpdateDetails && !showCheckIcon ? getDesktopUpdateIdleTooltip(state) : null;
  const tooltip = runsEverything
    ? everything.summary
    : showUpdateDetails
      ? state
        ? getDesktopUpdateButtonTooltip(state)
        : "Update available"
      : showCheckIcon
        ? "Checking for updates…"
        : state?.source === "lastcode-local" && state.status === "idle" && state.message
          ? getDesktopUpdateButtonTooltip(state)
          : (idleTooltip?.title ?? "Check for updates");
  const disabled = showCheckIcon
    ? true
    : runsEverything
      ? false
      : showUpdateDetails
        ? isDesktopUpdateButtonDisabled(state)
        : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;
  const localBuildFailure =
    state?.source === "lastcode-local" && shouldHighlightDesktopUpdateError(state)
      ? state.localBuildFailure
      : null;
  const progressPercent = state ? getDesktopUpdateProgressPercent(state) : null;
  const showUpdatePopover =
    !isRunningEverything &&
    (localBuildFailure !== null ||
      shouldUseSidebarUpdateReleaseNotesPopover(showUpdateDetails, state));

  useEffect(() => {
    if (!showUpdatePopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showUpdatePopover]);

  const handleAction = async () => {
    const bridge = window.desktopBridge;
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
      return;
    }

    if (!bridge || !state) return;
    setIsActionPending(true);

    if (action === "download") {
      void downloadLocalUpdate(bridge, { notifyDownloaded: true, isLocalBuild: state?.source === "lastcode-local" }).finally(() =>
        setIsActionPending(false),
      );
      return;
    }

    if (action === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(state),
        );
      } catch (error) {
        setIsActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsActionPending(false);
        return;
      }
      void installLocalUpdate(bridge).finally(() => setIsActionPending(false));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked && !result.error) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.error ??
              result.state.message ??
              "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setIsActionPending(false));
  };

  const runEverything = async () => {
    const bridge = window.desktopBridge;
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() =>
      everything.run({
        ...(bridge && action === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, isLocalBuild: state?.source === "lastcode-local", reportError }),
            }
          : {}),
        ...(bridge && action !== "none"
          ? { installLocal: (reportError) => installLocalUpdate(bridge, reportError) }
          : {}),
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update everything",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  };

  if (!isElectron && !runsEverything && !isRunningEverything) return null;

  if (!runsEverything && !isRunningEverything && state?.source === "lastcode-local" && !state.enabled) return null;

  const statusIcon = (
    <DesktopUpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      downloadPercent={progressPercent}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      status={iconStatus}
    />
  );
  const confirmDialog = (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      summary={everything.summary}
      lines={everything.lines}
      restarts={everything.restarts}
      skipped={everything.skipped}
      onConfirm={() => void runEverything()}
    />
  );

  if (run !== null) {
    const local: UpdateRunLocalState =
      run.localVersion === null
        ? null
        : state?.status === "downloading"
          ? { status: "downloading", percent: state.downloadPercent }
          : { status: "waiting" };
    return (
      <SidebarMenuItem className="ml-auto flex min-w-0 flex-1">
        <SidebarUpdateCapsule
          run={run}
          local={local}
          icon={statusIcon}
          {...(run.localVersion === null && action === "install" && window.desktopBridge
            ? {
                onRestart: async () => {
                  saveUpdateEverythingResult({
                    localVersion: localUpdateVersion,
                    updatedServers: 0,
                    updatedProviders: 0,
                    failures: [],
                    restarting: [],
                  });
                  if (!(await installLocalUpdate(window.desktopBridge!))) {
                    clearSavedUpdateEverythingResult();
                  }
                },
              }
            : {})}
        />
        {confirmDialog}
      </SidebarMenuItem>
    );
  }

  const updateButton = (
    <button
      type="button"
      aria-label={idleTooltip?.detail ? `${tooltip}: ${idleTooltip.detail}` : tooltip}
      aria-disabled={isInteractionDisabled || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
        resolveSidebarUpdateButtonToneClassName({
          hasLocalBuildFailure: localBuildFailure !== null,
          isInteractionDisabled,
          showUpdateIconState,
        }),
        (disabled && !showUpdateIconState) && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showUpdatePopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showUpdatePopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      {statusIcon}
    </button>
  );
  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showUpdatePopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showUpdatePopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showUpdatePopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showUpdatePopover}
                render={updateButton}
              />
            }
          />
          {!showUpdatePopover ? (
            <TooltipPopup
              align="center"
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {idleTooltip?.detail ? (
                <div className="text-left">
                  <div className="font-medium">{idleTooltip.title}</div>
                  <div className="text-muted-foreground">{idleTooltip.detail}</div>
                </div>
              ) : (
                <span className="whitespace-pre-line">{tooltip}</span>
              )}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showUpdatePopover && state ? (
          <PopoverPopup
            align="center"
            aria-label={
              localBuildFailure ? "Local build failure details" : "Nightly update release notes"
            }
            elevated
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            {localBuildFailure ? (
              <SidebarLocalBuildFailurePopover
                failure={localBuildFailure}
                isCopied={isCopied}
                onCopy={() => copyToClipboard(formatLocalBuildFailureDetails(localBuildFailure))}
              />
            ) : (
              <SidebarUpdateReleaseNotes
                shell={window.desktopBridge}
                state={state}
                tooltip={tooltip}
              />
            )}
          </PopoverPopup>
        ) : null}
      </Popover>
      {confirmDialog}
    </SidebarMenuItem>
  );
}
