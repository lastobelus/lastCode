import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  formatLocalBuildFailureDetails,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdatePopoverHeader,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateProgressPercent,
  MAX_LOCAL_BUILD_DIAGNOSTIC_LENGTH,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
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
  omittedReleaseCount: 0,
  downloadPercent: null,
  localBuildProgress: null,
  localBuildFailure: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("shows a pending checkpoint instead of claiming to be up to date", () => {
    const message = "Checkpoint requested. A later update check will pick up the result.";
    expect(getDesktopUpdateButtonTooltip({ ...baseState, source: "lastcode-local", message })).toBe(
      message,
    );
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
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
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
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/pingdotgg/t3code/releases/tag/v1.2.3",
      );
    },
  );

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
});

describe("getDesktopUpdatePopoverHeader", () => {
  const local: DesktopUpdateState = {
    ...baseState,
    source: "lastcode-local",
    currentVersion: "0.1.8-nightly.20261105.4218",
    availableVersion: "0.1.8-nightly.20261107.4301",
  };

  it.each<[string, Partial<DesktopUpdateState>, string | null]>([
    ["candidate", { status: "available" }, "Ready to build"],
    [
      "build in progress",
      {
        status: "downloading",
        localBuildProgress: {
          checkpointTag: "lastcode/checkpoint/v0.1.8-nightly.20261107.4301",
          phase: "Workspace tests",
          percent: 31,
          errorKind: "build",
        },
      },
      "Workspace tests · 31% est.",
    ],
    [
      "built package",
      { status: "downloaded", downloadedVersion: "0.1.8-nightly.20261107.4301" },
      "Built and ready to install · restart required",
    ],
    [
      "failed build",
      { status: "error", errorContext: "download" },
      "Build failed · click to retry",
    ],
    [
      "failed install",
      {
        status: "downloaded",
        errorContext: "install",
        downloadedVersion: "0.1.8-nightly.20261107.4301",
        canRetry: true,
      },
      "Install failed · click to retry",
    ],
    [
      "failed retry of an unapplied install",
      {
        status: "downloaded",
        errorContext: "install",
        downloadedVersion: "0.1.8-nightly.20261107.4301",
        notAppliedVersion: "0.1.8-nightly.20261107.4301",
      },
      "Install failed · click to retry",
    ],
    [
      "unapplied install",
      {
        status: "downloaded",
        downloadedVersion: "0.1.8-nightly.20261107.4301",
        notAppliedVersion: "0.1.8-nightly.20261107.4301",
      },
      "Did not apply last time · click to retry",
    ],
    ["no offer", { status: "idle", availableVersion: null }, null],
    ["check in progress", { status: "checking" }, null],
  ])("keeps the app target visible for a %s", (_name, change, readiness) => {
    const header = getDesktopUpdatePopoverHeader({ ...local, ...change }, "LastCode");
    expect(header?.readiness ?? null).toBe(readiness);
    if (readiness !== null) {
      expect(header?.title).toBe("LastCode 4218 → 4301");
      expect(header?.targetVersion).toBe("0.1.8-nightly.20261107.4301");
    }
  });

  it("names hosted versions in full and reports a failed download", () => {
    expect(
      getDesktopUpdatePopoverHeader(
        {
          ...baseState,
          currentVersion: "0.0.50-nightly.20260101.512",
          status: "available",
          availableVersion: "0.0.50-nightly.20260102.530",
          errorContext: "download",
          canRetry: true,
        },
        "T3 Code",
      ),
    ).toEqual({
      title: "T3 Code 0.0.50-nightly.20260101.512 → 0.0.50-nightly.20260102.530",
      readiness: "Download failed · click to retry",
      targetVersion: "0.0.50-nightly.20260102.530",
    });
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
