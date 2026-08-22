import { describe, expect, it } from "vite-plus/test";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnLocalBuildFailure,
  reduceDesktopUpdateStateOnLocalBuildProgress,
  reduceDesktopUpdateStateOnLocalBuildStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("keeps local progress separate from hosted byte progress and durable on failure", () => {
    const available = {
      ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "nightly"),
      enabled: true,
      source: "lastcode-local" as const,
      status: "available" as const,
      availableVersion: "1.1.0-nightly.1",
    };
    const started = reduceDesktopUpdateStateOnLocalBuildStart(available, {
      checkpointTag: "lastcode/checkpoint/v1.1.0-nightly.1",
      phase: "Preparing",
      percent: 0,
      errorKind: "build",
    });
    const progressed = reduceDesktopUpdateStateOnLocalBuildProgress(started, {
      checkpointTag: "lastcode/checkpoint/v1.1.0-nightly.1",
      phase: "Building DMG",
      percent: 94,
      errorKind: "packaging",
    });
    const failure = {
      ...progressed.localBuildProgress!,
      currentVersion: "1.0.0",
      targetVersion: "1.1.0-nightly.1",
      logPath: "/tmp/build.log",
      error: "dmg failed",
    };
    const failed = reduceDesktopUpdateStateOnLocalBuildFailure(progressed, failure);

    expect(started.downloadPercent).toBeNull();
    expect(progressed.downloadPercent).toBeNull();
    expect(failed.status).toBe("error");
    expect(failed.localBuildProgress).toEqual(progressed.localBuildProgress);
    expect(failed.localBuildFailure).toEqual(failure);
    expect(failed.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("clears stale download state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const releaseNotes = [
      {
        version: "1.1.0",
        items: ["feat: add update release notes"],
      },
    ];
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
      releaseNotes,
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const indeterminateDownload = reduceDesktopUpdateStateOnDownloadStart(available, null);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(available.channel).toBe("latest");
    expect(available.releaseNotes).toBe(releaseNotes);
    expect(downloading.releaseNotes).toBe(releaseNotes);
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBe(0);
    expect(indeterminateDownload.downloadPercent).toBeNull();
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });

  it("clears release notes when checking again", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "nightly"),
        enabled: true,
        status: "available",
        availableVersion: "1.1.0-nightly.1",
        releaseNotes: [{ version: "1.1.0-nightly.1", items: ["feat: old note"] }],
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.releaseNotes).toEqual([]);
  });
});
