import type {
  DesktopLocalBuildFailure,
  DesktopLocalBuildProgress,
  DesktopRuntimeInfo,
  DesktopUpdateChannel,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
} from "@t3tools/contracts";

export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateState["status"] {
  return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null;
}

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    source: "hosted",
    status: "disabled",
    channel,
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    localBuildProgress: null,
    localBuildFailure: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  const hasDownloadedUpdate = state.downloadedVersion !== null;
  return {
    ...state,
    status: "checking",
    checkedAt,
    releaseNotes: hasDownloadedUpdate ? state.releaseNotes : [],
    message: null,
    downloadPercent: hasDownloadedUpdate ? 100 : null,
    localBuildProgress: null,
    localBuildFailure: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
): DesktopUpdateState {
  if (state.downloadedVersion !== null) {
    return {
      ...state,
      status: "downloaded",
      message: null,
      checkedAt,
      downloadPercent: 100,
      errorContext: null,
      canRetry: true,
    };
  }

  return {
    ...state,
    status: "error",
    message,
    checkedAt,
    downloadPercent: null,
    localBuildProgress: null,
    localBuildFailure: null,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote> = [],
): DesktopUpdateState {
  const isDownloadedVersion = state.downloadedVersion === version;
  const nextReleaseNotes =
    isDownloadedVersion && releaseNotes.length === 0 ? state.releaseNotes : releaseNotes;
  return {
    ...state,
    status: isDownloadedVersion ? "downloaded" : "available",
    availableVersion: version,
    downloadedVersion: isDownloadedVersion ? version : null,
    releaseNotes: nextReleaseNotes,
    downloadPercent: isDownloadedVersion ? 100 : null,
    localBuildProgress: null,
    localBuildFailure: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: isDownloadedVersion,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  if (state.downloadedVersion !== null) {
    return {
      ...state,
      status: "downloaded",
      availableVersion: state.downloadedVersion,
      downloadPercent: 100,
      checkedAt,
      message: null,
      errorContext: null,
      canRetry: true,
    };
  }

  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    localBuildProgress: null,
    localBuildFailure: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
  downloadPercent: number | null = 0,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent,
    localBuildProgress: null,
    localBuildFailure: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    localBuildProgress: null,
    localBuildFailure: null,
    errorContext: "download",
    canRetry: getCanRetryAfterDownloadFailure(state),
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: percent,
    localBuildProgress: null,
    localBuildFailure: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    localBuildProgress: null,
    localBuildFailure: null,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnLocalBuildStart(
  state: DesktopUpdateState,
  progress: DesktopLocalBuildProgress,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: null,
    localBuildProgress: progress,
    localBuildFailure: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnLocalBuildProgress(
  state: DesktopUpdateState,
  progress: DesktopLocalBuildProgress,
): DesktopUpdateState {
  if (
    state.source !== "lastcode-local" ||
    state.status !== "downloading" ||
    state.localBuildProgress?.checkpointTag !== progress.checkpointTag ||
    progress.percent < state.localBuildProgress.percent
  ) {
    return state;
  }
  return {
    ...state,
    downloadPercent: null,
    localBuildProgress: progress,
  };
}

export function reduceDesktopUpdateStateOnLocalBuildFailure(
  state: DesktopUpdateState,
  failure: DesktopLocalBuildFailure,
): DesktopUpdateState {
  return {
    ...state,
    status: "error",
    downloadPercent: null,
    localBuildProgress: {
      checkpointTag: failure.checkpointTag,
      phase: failure.phase,
      percent: failure.percent,
      errorKind: failure.errorKind,
    },
    localBuildFailure: failure,
    message: failure.error,
    errorContext: "download",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    message,
    errorContext: "install",
    canRetry: true,
  };
}
