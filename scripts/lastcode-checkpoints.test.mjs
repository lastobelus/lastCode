import { describe, expect, it } from "vite-plus/test";

import {
  checkpointTagsWithoutUnpublishedFailures,
  checkpointFreshness,
  failureDetailLines,
  failedRunsWithoutPublishedTags,
  formatDuration,
  parseOptions,
  parseRemotePublicationState,
  parseTrailers,
  renderLauncher,
  selectAutomationWorktree,
  selectCheckpointTags,
  selectNightlySyncWorktree,
} from "./lastcode-checkpoints.mjs";

describe("LastCode checkpoint dashboard", () => {
  it("shows eight entries by default and accepts a count override", () => {
    expect(parseOptions([]).count).toBe(8);
    expect(parseOptions(["-n", "12"]).count).toBe(12);
    expect(parseOptions(["--verbose"]).verbose).toBe(true);
    expect(() => parseOptions(["-n", "0"])).toThrow("Invalid checkpoint count");
  });

  it("parses checkpoint metadata trailers", () => {
    expect(parseTrailers("Title\n\nUpstream-Tag: v1-nightly.1\nDuration-Ms: 128000\n")).toEqual({
      "Upstream-Tag": "v1-nightly.1",
      "Duration-Ms": "128000",
    });
  });

  it("formats durations compactly", () => {
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(188_000)).toBe("3m 08s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("limits metadata expansion to the requested newest checkpoints", () => {
    expect(
      selectCheckpointTags(
        [
          "lastcode/checkpoint/v0.0.1-nightly.20260812.1",
          "lastcode/checkpoint/v0.0.1-nightly.20260812.3",
          "lastcode/checkpoint/v0.0.1-nightly.20260812.2",
        ],
        2,
      ),
    ).toEqual([
      "lastcode/checkpoint/v0.0.1-nightly.20260812.3",
      "lastcode/checkpoint/v0.0.1-nightly.20260812.2",
    ]);
  });

  it("does not report missing checkpoint data as up to date", () => {
    expect(checkpointFreshness(undefined, undefined)).toBe("Upstream unavailable");
    expect(checkpointFreshness("v0.0.1-nightly.20260812.1", undefined)).toBe("Checkpoint pending");
    expect(checkpointFreshness("v0.0.1-nightly.20260812.1", "v0.0.1-nightly.20260812.1")).toBe(
      "Up to date",
    );
  });

  it("launches the installed dashboard with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/checkpoints.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/checkpoints.mjs' \"$@\"",
    );
  });

  it("requires the dedicated automation worktree for a durable installation", () => {
    expect(
      selectAutomationWorktree(
        "worktree /Users/lasto/projects/lastCode\n\nworktree /Users/lasto/projects/lastCode-worktrees/lastcode-automation\n",
      ),
    ).toBe("/Users/lasto/projects/lastCode-worktrees/lastcode-automation");
    expect(selectAutomationWorktree("worktree /Users/lasto/projects/lastCode\n")).toBeUndefined();
  });

  it("finds the retained nightly recovery worktree", () => {
    expect(
      selectNightlySyncWorktree(
        "worktree /Users/lasto/projects/lastCode\n\nworktree /Users/lasto/projects/lastCode-worktrees/lastcode-nightly-sync\n",
      ),
    ).toBe("/Users/lasto/projects/lastCode-worktrees/lastcode-nightly-sync");
    expect(selectNightlySyncWorktree("worktree /Users/lasto/projects/lastCode\n")).toBeUndefined();
  });

  it("lets a published checkpoint tag reconcile an ambiguous failed push record", () => {
    const publishedTag = "lastcode/checkpoint/v0.0.1-nightly.20260812.2";
    const failedRecord = {
      upstreamTag: "v0.0.1-nightly.20260812.2",
      status: "failed",
    };
    expect(failedRunsWithoutPublishedTags([publishedTag], [failedRecord])).toEqual([]);
    expect(failedRunsWithoutPublishedTags([], [failedRecord])).toEqual([failedRecord]);
  });

  it("shows full failure details only in verbose mode", () => {
    const rows = [
      {
        status: "failed",
        upstreamTag: "v0.0.1-nightly.20260812.2",
        error: "rebase failed",
        recoveryBranch: "sync/nightly/v0.0.1-nightly.20260812.2",
      },
    ];
    expect(failureDetailLines(rows, false)).toEqual([]);
    expect(failureDetailLines(rows, true)).toEqual([
      "Failure v0.0.1-nightly.20260812.2: rebase failed · Recovery: sync/nightly/v0.0.1-nightly.20260812.2",
    ]);
  });

  it("keeps a tag with retained recovery state in the failed state", () => {
    const tag = "lastcode/checkpoint/v0.0.1-nightly.20260812.2";
    const failedRecord = {
      upstreamTag: "v0.0.1-nightly.20260812.2",
      status: "failed",
      localTagRetained: true,
      recoveryBranch: "sync/nightly/v0.0.1-nightly.20260812.2",
    };
    expect(checkpointTagsWithoutUnpublishedFailures([tag], [], [failedRecord])).toEqual([]);
    expect(failedRunsWithoutPublishedTags([], [failedRecord])).toEqual([failedRecord]);
    expect(checkpointTagsWithoutUnpublishedFailures([tag], [tag], [failedRecord])).toEqual([tag]);
    expect(failedRunsWithoutPublishedTags([tag], [failedRecord])).toEqual([]);
  });

  it("reads published tags and main from one remote snapshot", () => {
    expect(
      parseRemotePublicationState(
        "main-sha\trefs/heads/lastcode/main\ntag-sha\trefs/tags/lastcode/checkpoint/v1\npeeled\trefs/tags/lastcode/checkpoint/v1^{}\n",
      ),
    ).toEqual({
      publishedTags: ["lastcode/checkpoint/v1"],
      remoteMain: "main-sha",
    });
  });
});
