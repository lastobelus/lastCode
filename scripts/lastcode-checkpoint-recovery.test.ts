// @effect-diagnostics nodeBuiltinImport:off -- Host-side disposable Git fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  assertRecoverySelection,
  carryRecoveryBranch,
  checkpointFailureDisposition,
  parseRecoverySelection,
  publishedRecoveryInstallable,
  recoveryPublicationArgs,
  type RecoverySelection,
} from "./lastcode-checkpoint.ts";
import { parseNightlyTag } from "./lastcode-nightly.ts";

const NIGHTLY_TAG = "v0.0.39-nightly.20260905.1286";
const SOURCE_COMMIT = "b".repeat(40);

function git(repository: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  }).trim();
}

function fixture(): {
  readonly repository: string;
  readonly selection: RecoverySelection;
} {
  const repository = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-checkpoint-recovery-"),
  );
  onTestFinished(() => NodeFS.rmSync(repository, { force: true, recursive: true }));
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "checkpoint@example.com"]);
  git(repository, ["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(repository, "fixture.txt"), "upstream\n");
  git(repository, ["add", "fixture.txt"]);
  git(repository, ["commit", "-m", "upstream nightly"]);
  git(repository, ["tag", NIGHTLY_TAG]);
  git(repository, ["checkout", "-b", `sync/nightly/${NIGHTLY_TAG}`]);
  NodeFS.appendFileSync(NodePath.join(repository, "fixture.txt"), "repaired\n");
  git(repository, ["commit", "-am", "repair nightly rebase"]);

  return {
    repository,
    selection: {
      head: git(repository, ["rev-parse", "HEAD"]),
      sourceCommit: SOURCE_COMMIT,
      nightlyTag: NIGHTLY_TAG,
    },
  };
}

function publicationFixture(): {
  readonly remote: string;
  readonly repository: string;
  readonly selection: RecoverySelection;
  readonly tag: string;
} {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-publication-"));
  onTestFinished(() => NodeFS.rmSync(root, { force: true, recursive: true }));
  const remote = NodePath.join(root, "remote.git");
  const repository = NodePath.join(root, "repository");
  NodeFS.mkdirSync(repository);
  git(root, ["init", "--bare", remote]);
  git(repository, ["init", "--initial-branch=source"]);
  git(repository, ["config", "user.email", "checkpoint@example.com"]);
  git(repository, ["config", "user.name", "Checkpoint Test"]);
  git(repository, ["remote", "add", "origin", remote]);
  NodeFS.writeFileSync(NodePath.join(repository, "fixture.txt"), "source\n");
  git(repository, ["add", "fixture.txt"]);
  git(repository, ["commit", "-m", "source main"]);
  const sourceCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);
  git(repository, ["checkout", "-b", `sync/nightly/${NIGHTLY_TAG}`]);
  NodeFS.appendFileSync(NodePath.join(repository, "fixture.txt"), "repaired\n");
  git(repository, ["commit", "-am", "repaired checkpoint"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const tag = `lastcode/checkpoint/${NIGHTLY_TAG}`;
  git(repository, ["tag", tag, head]);
  return {
    remote,
    repository,
    selection: { head, sourceCommit, nightlyTag: NIGHTLY_TAG },
    tag,
  };
}

describe("checkpoint recovery selection", () => {
  it("atomically publishes the repaired tag and promotes its exact head", () => {
    const { remote, repository, selection, tag } = publicationFixture();
    const result = NodeChildProcess.spawnSync(
      "git",
      recoveryPublicationArgs("origin", tag, selection),
      { cwd: repository, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(git(remote, ["rev-parse", "refs/heads/lastcode/main"])).toBe(selection.head);
    expect(git(remote, ["rev-parse", `${tag}^{commit}`])).toBe(selection.head);
    expect(git(remote, ["rev-parse", `refs/lastcode/sources/${NIGHTLY_TAG}^{commit}`])).toBe(
      selection.sourceCommit,
    );
  });

  it("publishes neither ref when main advanced beyond the selected source", () => {
    const { remote, repository, selection, tag } = publicationFixture();
    git(repository, ["checkout", "source"]);
    NodeFS.writeFileSync(NodePath.join(repository, "advanced.txt"), "new main work\n");
    git(repository, ["add", "advanced.txt"]);
    git(repository, ["commit", "-m", "advance main"]);
    const advanced = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);

    const result = NodeChildProcess.spawnSync(
      "git",
      recoveryPublicationArgs("origin", tag, selection),
      { cwd: repository, encoding: "utf8" },
    );
    const remoteTag = NodeChildProcess.spawnSync(
      "git",
      ["--git-dir", remote, "rev-parse", "--verify", `refs/tags/${tag}`],
      { encoding: "utf8" },
    );
    const remoteSource = NodeChildProcess.spawnSync(
      "git",
      ["--git-dir", remote, "rev-parse", "--verify", `refs/lastcode/sources/${NIGHTLY_TAG}`],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stale info");
    expect(git(remote, ["rev-parse", "refs/heads/lastcode/main"])).toBe(advanced);
    expect(remoteTag.status).not.toBe(0);
    expect(remoteSource.status).not.toBe(0);
  });

  it("reconciles a published recovery revision after an interrupted service run", () => {
    const selection: RecoverySelection = {
      head: "a".repeat(40),
      sourceCommit: SOURCE_COMMIT,
      nightlyTag: NIGHTLY_TAG,
    };
    expect(
      publishedRecoveryInstallable(
        [
          {
            tag: `lastcode/revision/${NIGHTLY_TAG}.1`,
            commit: selection.head,
            nightly: parseNightlyTag(NIGHTLY_TAG)!,
            revision: 1,
            sourceCommit: selection.sourceCommit,
          },
        ],
        selection,
      )?.tag,
    ).toBe(`lastcode/revision/${NIGHTLY_TAG}.1`);
  });

  it("retains committed repairs when publication fails after deleting its local tag", () => {
    expect(checkpointFailureDisposition("pending-tag", "recovery", true, true)).toEqual({
      cleanup: false,
      recoveryBranch: "recovery",
    });
  });
  it("parses exact full commits and a nightly tag", () => {
    const selection = {
      head: "a".repeat(40),
      sourceCommit: SOURCE_COMMIT,
      nightlyTag: NIGHTLY_TAG,
    };
    expect(parseRecoverySelection(selection)).toEqual(selection);
  });

  it("retains an explicit historical rollback across the service continuation", () => {
    const selection = {
      head: "a".repeat(40),
      sourceCommit: SOURCE_COMMIT,
      nightlyTag: NIGHTLY_TAG,
      replayMode: "historical" as const,
      rollbackReason: "carry compiler regression",
    };
    expect(parseRecoverySelection(selection)).toEqual(selection);
  });

  it("uses a selectable nightly branch for same-nightly carry compilation", () => {
    expect(carryRecoveryBranch(NIGHTLY_TAG)).toBe(`sync/nightly/${NIGHTLY_TAG}`);
    expect(() => carryRecoveryBranch("nightly-latest")).toThrow("exact nightly tag");
  });

  it("rejects empty or non-historical rollback metadata", () => {
    expect(() =>
      parseRecoverySelection({
        head: "a".repeat(40),
        sourceCommit: SOURCE_COMMIT,
        nightlyTag: NIGHTLY_TAG,
        replayMode: "historical",
        rollbackReason: "   ",
      }),
    ).toThrow("invalid rollback reason");
    expect(() =>
      parseRecoverySelection({
        head: "a".repeat(40),
        sourceCommit: SOURCE_COMMIT,
        nightlyTag: NIGHTLY_TAG,
        replayMode: "carry",
        rollbackReason: "compiler regression",
      }),
    ).toThrow("requires historical replay mode");
  });

  it("rejects malformed selections and abbreviated commits", () => {
    expect(() => parseRecoverySelection(null)).toThrow("Invalid recovery selection");
    expect(() =>
      parseRecoverySelection({
        head: "abc1234",
        sourceCommit: SOURCE_COMMIT,
        nightlyTag: NIGHTLY_TAG,
      }),
    ).toThrow("full commits");
    expect(() =>
      parseRecoverySelection({
        head: "a".repeat(40),
        sourceCommit: "deadbeef",
        nightlyTag: NIGHTLY_TAG,
      }),
    ).toThrow("full commits");
    expect(() =>
      parseRecoverySelection({
        head: "a".repeat(40),
        sourceCommit: SOURCE_COMMIT,
        nightlyTag: "nightly-latest",
      }),
    ).toThrow("exact nightly tag");
  });

  it("accepts a clean committed repaired branch containing the selected nightly", () => {
    const { repository, selection } = fixture();
    expect(() => assertRecoverySelection(repository, selection, SOURCE_COMMIT)).not.toThrow();
  });

  it("rejects tracked and untracked recovery changes", () => {
    const tracked = fixture();
    NodeFS.appendFileSync(NodePath.join(tracked.repository, "fixture.txt"), "dirty\n");
    expect(() =>
      assertRecoverySelection(tracked.repository, tracked.selection, SOURCE_COMMIT),
    ).toThrow("must be clean");

    const untracked = fixture();
    NodeFS.writeFileSync(NodePath.join(untracked.repository, "untracked.txt"), "not committed\n");
    expect(() =>
      assertRecoverySelection(untracked.repository, untracked.selection, SOURCE_COMMIT),
    ).toThrow("must be clean");
  });

  it("rejects a different recovery head, branch, or source commit", () => {
    const wrongHead = fixture();
    expect(() =>
      assertRecoverySelection(
        wrongHead.repository,
        { ...wrongHead.selection, head: "c".repeat(40) },
        SOURCE_COMMIT,
      ),
    ).toThrow("head or branch changed");

    const wrongBranch = fixture();
    git(wrongBranch.repository, ["branch", "--move", "sync/nightly/unselected"]);
    expect(() =>
      assertRecoverySelection(wrongBranch.repository, wrongBranch.selection, SOURCE_COMMIT),
    ).toThrow("head or branch changed");

    const wrongSource = fixture();
    expect(() =>
      assertRecoverySelection(wrongSource.repository, wrongSource.selection, "d".repeat(40)),
    ).toThrow("Recovery source changed");
  });

  it("rejects a missing or uncontained upstream nightly", () => {
    const { repository, selection } = fixture();
    const missingNightly = "v0.0.39-nightly.20260905.1287";
    git(repository, ["branch", "--move", `sync/nightly/${missingNightly}`]);
    expect(() =>
      assertRecoverySelection(
        repository,
        { ...selection, nightlyTag: missingNightly },
        SOURCE_COMMIT,
      ),
    ).toThrow("does not contain the selected upstream nightly");
  });

  it("rejects a recovery while rebase state remains", () => {
    const { repository, selection } = fixture();
    NodeFS.mkdirSync(NodePath.join(repository, ".git", "rebase-merge"));
    expect(() => assertRecoverySelection(repository, selection, SOURCE_COMMIT)).toThrow(
      "rebase completed",
    );
  });
});
