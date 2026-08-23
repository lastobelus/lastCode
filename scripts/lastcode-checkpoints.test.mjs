import { describe, expect, it } from "vite-plus/test";

import {
  checkpointTagsWithoutUnpublishedFailures,
  checkpointFreshness,
  failureDetailLines,
  failureWasDuringRebase,
  failedRunsWithoutPublishedTags,
  formatRecoveryProblemLines,
  formatDuration,
  parseRebaseRange,
  parseOptions,
  parseRemotePublicationState,
  parseTrailers,
  recoveryActionLines,
  renderLauncher,
  selectAutomationWorktree,
  selectCheckpointTags,
  selectRevisionBuilds,
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

  it("nests only built LastCode revisions beneath their checkpoint", () => {
    expect(
      selectRevisionBuilds("lastcode/checkpoint/v0.0.34-nightly.20260817.1113", [
        "lastcode/build/v0.0.34-nightly.20260817.1113.1",
        "lastcode/build/v0.0.34-nightly.20260817.1113.1.1",
        "lastcode/build/v0.0.34-nightly.20260817.1113.3.1",
        "lastcode/build/v0.0.34-nightly.20260817.1113.3.2",
        "lastcode/build/v0.0.34-nightly.20260816.1112.1.9",
      ]),
    ).toEqual([
      {
        build: 1,
        buildTag: "lastcode/build/v0.0.34-nightly.20260817.1113.1.1",
        revisionTag: "lastcode/revision/v0.0.34-nightly.20260817.1113.1",
        version: "v0.0.34-nightly.20260817.1113.1",
      },
      {
        build: 2,
        buildTag: "lastcode/build/v0.0.34-nightly.20260817.1113.3.2",
        revisionTag: "lastcode/revision/v0.0.34-nightly.20260817.1113.3",
        version: "v0.0.34-nightly.20260817.1113.3",
      },
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

  it("shows the complete recovery lifecycle for a retained rebase", () => {
    expect(
      recoveryActionLines({
        repoRoot: "/tmp/Last Code",
        worktree: "/tmp/Last Code-worktrees/lastcode-nightly-sync",
        automationWorktree: "/tmp/Last Code-worktrees/lastcode-automation",
        recoveryBranch: "sync/nightly/v1",
        isRebaseInProgress: true,
        failedDuringRebase: true,
      }),
    ).toEqual([
      "Resolve and stage conflicts, then repeat until the rebase finishes: git -C '/tmp/Last Code-worktrees/lastcode-nightly-sync' rebase --continue",
      "Release the daemon: git -C '/tmp/Last Code' worktree remove '/tmp/Last Code-worktrees/lastcode-nightly-sync'",
      "Delete the generated recovery branch: git -C '/tmp/Last Code' branch -D 'sync/nightly/v1'",
      "Retry now: pnpm --dir '/tmp/Last Code-worktrees/lastcode-automation' lastcode:checkpoint:service run-now",
    ]);
  });

  it("distinguishes smoke-gate recovery from an interrupted rebase", () => {
    expect(
      recoveryActionLines({
        repoRoot: "/tmp/repo",
        worktree: "/tmp/recovery",
        automationWorktree: "/tmp/automation",
        recoveryBranch: "sync/nightly/v1",
        isRebaseInProgress: false,
        failedDuringRebase: false,
      })[0],
    ).toBe(
      "No rebase is in progress. Fix the smoke failure on lastcode/main, then discard this retained attempt.",
    );
  });

  it("uses explicit failure phases and recognizes historical rebase commands", () => {
    expect(failureWasDuringRebase({ failurePhase: "rebase", error: "anything" })).toBe(true);
    expect(failureWasDuringRebase({ failurePhase: "smoke", error: "git rebase failed" })).toBe(
      false,
    );
    expect(
      failureWasDuringRebase({
        error: "git -c core.editor=true rebase --continue failed with exit code 1.",
      }),
    ).toBe(true);
  });

  it("extracts the checkpoint range from a failed rebase command", () => {
    expect(
      parseRebaseRange(
        "git rebase --onto v0.0.34-nightly.20260823.1167 v0.0.34-nightly.20260823.1166 failed with exit code 1.",
      ),
    ).toEqual({
      upstreamTag: "v0.0.34-nightly.20260823.1167",
      previousUpstreamTag: "v0.0.34-nightly.20260823.1166",
    });
    expect(parseRebaseRange("smoke failed")).toBeUndefined();
  });

  it("explains the stopped commit and the upstream change touching conflicted files", () => {
    expect(
      formatRecoveryProblemLines({
        stoppedCommit: "8bac1eb94 feat(lastcode): resume agents after opted-in Actions (#28)",
        conflictPaths: ["packages/contracts/src/rpc.ts"],
        previousUpstreamTag: "v0.0.34-nightly.20260823.1166",
        upstreamTag: "v0.0.34-nightly.20260823.1167",
        overlappingUpstreamCommits: [
          "3db38b881 feat(codex): submit thread feedback to OpenAI (#7949)",
        ],
      }),
    ).toEqual([
      "Problem: Git could not replay LastCode commit 8bac1eb94 feat(lastcode): resume agents after opted-in Actions (#28).",
      "Conflicted file:",
      "  packages/contracts/src/rpc.ts",
      "Upstream commits touching that file between v0.0.34-nightly.20260823.1166 and v0.0.34-nightly.20260823.1167:",
      "  3db38b881 feat(codex): submit thread feedback to OpenAI (#7949)",
    ]);
  });

  it("does not diagnose an in-flight retained attempt as a smoke failure", () => {
    expect(
      recoveryActionLines({
        repoRoot: "/tmp/repo",
        worktree: "/tmp/recovery",
        isRebaseInProgress: false,
        failedDuringRebase: false,
        hasFailureRecord: false,
      })[0],
    ).toBe(
      "Automation is still working or has not recorded the failure yet; wait for it to finish before changing the retained attempt.",
    );
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
