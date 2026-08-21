import type {
  DesktopLocalBuildFailure,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_TAG_URL = "https://github.com/pingdotgg/t3code/releases/tag";
export const MAX_LOCAL_BUILD_DIAGNOSTIC_LENGTH = 40_000;

function stripTerminalEscapeSequences(value: string): string {
  let plain = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      plain += value[index];
      continue;
    }

    const introducer = value[index + 1];
    index += 1;
    if (introducer === "[") {
      while (index + 1 < value.length) {
        index += 1;
        const code = value.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
      }
    } else if (introducer === "]") {
      while (index + 1 < value.length) {
        index += 1;
        if (value.charCodeAt(index) === 7) break;
        if (value.charCodeAt(index) === 27 && value[index + 1] === "\\") {
          index += 1;
          break;
        }
      }
    }
  }
  return plain;
}

function sanitizeLocalBuildDiagnosticValue(
  value: string,
  maxLength: number,
  preserveLines = false,
): string {
  const withoutAnsi = stripTerminalEscapeSequences(value);
  let sanitized = "";
  for (const character of withoutAnsi) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) {
      if (preserveLines && (character === "\n" || character === "\t")) sanitized += character;
      continue;
    }
    sanitized += character;
    if (sanitized.length >= maxLength) break;
  }
  return sanitized.trim();
}

export function formatLocalBuildFailureError(error: string): string {
  return sanitizeLocalBuildDiagnosticValue(error, 32_000, true);
}

export function formatLocalBuildFailureDetails(failure: DesktopLocalBuildFailure): string {
  const context = failure.errorKind === "packaging" ? "Packaging" : "Build";
  return [
    "[lastcode:local-update] Local LastCode build failed",
    `Installed version: ${sanitizeLocalBuildDiagnosticValue(failure.currentVersion, 200)}`,
    `Target version: ${sanitizeLocalBuildDiagnosticValue(failure.targetVersion, 200)}`,
    `Checkpoint: ${sanitizeLocalBuildDiagnosticValue(failure.checkpointTag, 500)}`,
    `Last phase: ${sanitizeLocalBuildDiagnosticValue(failure.phase, 100)} · ${failure.percent}% est.`,
    `Failure context: ${context}`,
    `Error: ${formatLocalBuildFailureError(failure.error)}`,
    `Build log: ${sanitizeLocalBuildDiagnosticValue(failure.logPath, 4_096)}`,
  ]
    .join("\n")
    .slice(0, MAX_LOCAL_BUILD_DIAGNOSTIC_LENGTH);
}

export function getDesktopUpdateProgressPercent(state: DesktopUpdateState): number | null {
  return state.source === "lastcode-local"
    ? (state.localBuildProgress?.percent ?? null)
    : state.downloadPercent;
}

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  const isLocal = state.source === "lastcode-local";
  if (state.status === "available") {
    return isLocal
      ? `LastCode ${state.availableVersion ?? "update"} ready to build`
      : `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    if (isLocal && state.localBuildProgress) {
      return `${state.localBuildProgress.phase} · ${state.localBuildProgress.percent}% est.`;
    }
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return isLocal
      ? `Building and staging local nightly${progress}`
      : `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return isLocal
      ? `LastCode ${state.downloadedVersion ?? state.availableVersion ?? "nightly"} built. Click to restart and install.`
      : `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return isLocal
        ? `Local build failed for ${state.availableVersion}. Click to retry.`
        : `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion"> &
    Partial<Pick<DesktopUpdateState, "source">>,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const appName = state.source === "lastcode-local" ? "LastCode" : "T3 Code";
  return `Install update${version ? ` ${version}` : ""} and restart ${appName}?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
