import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  formatLocalBuildFailureDetails,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateProgressPercent,
  MAX_LOCAL_BUILD_DIAGNOSTIC_LENGTH,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  source: "hosted",
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
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

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers install when a downloaded version already exists", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });

  it("uses typed local estimates without changing hosted byte progress", () => {
    const localState: DesktopUpdateState = {
      ...baseState,
      source: "lastcode-local",
      status: "downloading",
      availableVersion: "1.1.0-nightly.2",
      downloadPercent: null,
      localBuildProgress: {
        checkpointTag: "lastcode/checkpoint/v1.1.0-nightly.2",
        phase: "Workspace tests",
        percent: 31,
        errorKind: "build",
      },
    };

    expect(getDesktopUpdateProgressPercent(localState)).toBe(31);
    expect(getDesktopUpdateButtonTooltip(localState)).toBe("Workspace tests · 31% est.");

    const hostedState = { ...baseState, status: "downloading", downloadPercent: 42.5 } as const;
    expect(getDesktopUpdateProgressPercent(hostedState)).toBe(42.5);
    expect(getDesktopUpdateButtonTooltip(hostedState)).toBe("Downloading update (42%)");
  });
});

describe("local build failure diagnostic", () => {
  it("formats a prompt-ready bounded diagnostic and strips terminal controls", () => {
    const details = formatLocalBuildFailureDetails({
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.4",
      phase: "Building DMG",
      percent: 94,
      errorKind: "packaging",
      currentVersion: "1.2.2",
      targetVersion: "1.2.3-nightly.4",
      logPath: "/Users/test/.lastcode/local-updates/build.log",
      error: `hdiutil \u001B[31mfailed\u001B[0m\0${"x".repeat(32_000)}`,
    });

    expect(details).toContain("[lastcode:local-update] Local LastCode build failed");
    expect(details).toContain("Installed version: 1.2.2");
    expect(details).toContain("Target version: 1.2.3-nightly.4");
    expect(details).toContain("Checkpoint: lastcode/checkpoint/v1.2.3-nightly.4");
    expect(details).toContain("Last phase: Building DMG · 94% est.");
    expect(details).toContain("Failure context: Packaging");
    expect(details).toContain("Error: hdiutil failed");
    expect(details).toContain("Build log: /Users/test/.lastcode/local-updates/build.log");
    expect(details).not.toContain("\u001B");
    expect(details).not.toContain("\0");
    expect(details.length).toBeLessThanOrEqual(MAX_LOCAL_BUILD_DIAGNOSTIC_LENGTH);
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("sanitizes local failure toasts without changing hosted messages", () => {
    const rawMessage = "hdiutil \u001B[31mfailed\u001B[0m\0";
    const failure = {
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.4",
      phase: "Building DMG",
      percent: 94,
      errorKind: "packaging" as const,
      currentVersion: "1.2.2",
      targetVersion: "1.2.3-nightly.4",
      logPath: "/Users/test/.lastcode/local-updates/build.log",
      error: rawMessage,
    };

    expect(
      getDesktopUpdateActionError({
        accepted: true,
        completed: false,
        state: {
          ...baseState,
          source: "lastcode-local",
          status: "error",
          message: rawMessage,
          errorContext: "download",
          localBuildProgress: failure,
          localBuildFailure: failure,
        },
      }),
    ).toBe("hdiutil failed");
    expect(
      getDesktopUpdateActionError({
        accepted: true,
        completed: false,
        state: { ...baseState, status: "error", message: rawMessage },
      }),
    ).toBe(rawMessage);
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("builds the stable release URL for a downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("omits the release URL when the updater does not report a version", () => {
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
    expect(getDesktopUpdateReleaseUrl("  ")).toBeNull();
  });

  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart T3 Code?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart T3 Code?");
  });

  it("uses build and LastCode language for local nightlies", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      source: "lastcode-local",
      status: "available",
      availableVersion: "1.1.0-nightly.20260814.1",
    };

    expect(getDesktopUpdateButtonTooltip(state)).toContain("ready to build");
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        source: "lastcode-local",
        availableVersion: state.availableVersion,
        downloadedVersion: state.availableVersion,
      }),
    ).toContain("restart LastCode?");
  });

  it("keeps the same install confirmation copy across desktop platforms", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(
      "Install update 1.1.0 and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns false once an update has been downloaded", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(false);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });
});
