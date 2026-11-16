import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test, onTestFinished } from "vite-plus/test";

import * as history from "./lastcode-checkpoint-history.ts";

const upstreamTag = "v0.0.1-nightly.20260812.1";
const failure = () =>
  history.checkpointFailureRecord(
    {
      upstreamTag,
      startedAtMs: 1_000,
      commitsRebased: 2,
      error: new Error("replay failed"),
    },
    2_000,
  );

test("reconstructs one episode across legacy, failed, revision and successful attempts", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-effort-"));
  try {
    const nightly = NodePath.join(directory, "checkpoint-runs.jsonl");
    const revision = NodePath.join(directory, "checkpoint-revision-runs.jsonl");
    const legacy = failure();
    NodeFS.writeFileSync(nightly, `${JSON.stringify(legacy)}\n{"interrupted"`);
    const stop = {
      replayId: "synthetic-replay",
      group: "tooling",
      commit: "a".repeat(40),
      kind: "fold",
      conflictedPaths: { test: 1, generated: 1, other: 2 },
    };
    NodeAssert.equal(
      history.appendCheckpointRun({ ...failure(), replayStops: [stop] }, nightly),
      true,
    );
    NodeAssert.equal(
      history.appendCheckpointRevisionRun(
        {
          ...failure(),
          replayStops: [stop],
          failingSteps: ["Workspace tests (@fixture/web)"],
        },
        revision,
      ),
      true,
    );
    NodeAssert.equal(
      history.appendCheckpointRun({ ...failure(), status: "success" }, nightly),
      true,
    );
    const records = [
      ...history.readCheckpointRuns(nightly),
      ...history.readCheckpointRuns(revision),
    ].sort((a, b) => (a.attemptOrdinal ?? 1) - (b.attemptOrdinal ?? 1));
    NodeAssert.equal(records.length, 4);
    NodeAssert.deepEqual(
      records.slice(1).map((record) => record.attemptOrdinal),
      [2, 3, 4],
    );
    NodeAssert.ok(records.slice(1).every((record) => record.episodeKey === upstreamTag));
    NodeAssert.equal(records.flatMap((record) => record.replayStops ?? []).length, 1);
    NodeAssert.deepEqual(records[2].failingSteps, ["Workspace tests (@fixture/web)"]);
    NodeAssert.equal(history.readLatestCheckpointRun(nightly)?.status, "success");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const replay = await import("./lastcode-carry-replay.ts");
const NodeChildProcess = await import("node:child_process");
function git(repo, args) {
  return NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(repo, file, content) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, file), content);
}
function commit(repo, message) {
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}
function repository() {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-stops-"));
  onTestFinished(() => NodeFS.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Checkpoint fixture"]);
  git(repo, ["config", "user.email", "checkpoint@example.invalid"]);
  return repo;
}

test("persists every replay stop through continuation and keeps retry observations unique", () => {
  const repo = repository();
  const firstPaths = [
    "src/feature.test.ts",
    "src/__generated__/api.ts",
    "src/feature.ts",
    "apps/server/src/provider/agentContextBudget.json",
    "pnpm-lock.yaml",
    "apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson",
  ];
  for (const file of [...firstPaths, "later.txt"]) write(repo, file, "base\n");
  const base = commit(repo, "upstream base");
  for (const file of firstPaths) write(repo, file, "carry\n");
  commit(repo, "tooling contribution\n\nCarry-Group: tooling");
  write(repo, "later.txt", "carry\n");
  const source = commit(repo, "incubator contribution\n\nCarry-Group: incubator");
  const compact = replay.compileCarrySetSameBase({
    repo,
    worktree: repo,
    base,
    source,
    preparedPartition: { base, source, head: source },
  }).head;
  git(repo, ["checkout", "--quiet", "-B", "upstream", base]);
  for (const file of [...firstPaths, "later.txt"]) write(repo, file, "upstream\n");
  const onto = commit(repo, "upstream changes both groups");
  git(repo, ["checkout", "--quiet", "-B", "replay", compact]);
  NodeAssert.throws(() =>
    replay.replayCarrySetOnto({
      repo,
      worktree: repo,
      sourceBase: base,
      compactHead: compact,
      onto,
    }),
  );
  let stops = replay.readCarryReplayStops(repo);
  NodeAssert.equal(stops.length, 1);
  NodeAssert.equal(stops[0].kind, "replay");
  NodeAssert.equal(stops[0].group, "tooling");
  NodeAssert.deepEqual(stops[0].conflictedPaths, { test: 1, generated: 4, other: 1 });
  NodeAssert.throws(() => replay.continueCarryReplay(repo));
  NodeAssert.deepEqual(replay.readCarryReplayStops(repo), stops);
  for (const file of firstPaths) write(repo, file, "resolved\n");
  git(repo, ["add", "--all"]);
  NodeAssert.throws(() => replay.continueCarryReplay(repo));
  stops = replay.readCarryReplayStops(repo);
  NodeAssert.deepEqual(
    stops.map(({ group }) => group),
    ["tooling", "incubator"],
  );
  write(repo, "later.txt", "resolved\n");
  git(repo, ["add", "--all"]);
  replay.continueCarryReplay(repo);
  NodeAssert.deepEqual(replay.readCarryReplayStops(repo), stops);
  const nightly = NodePath.join(repo, "checkpoint-runs.jsonl");
  history.appendCheckpointRun({ ...failure(), replayStops: stops.slice(0, 1) }, nightly);
  history.appendCheckpointRun({ ...failure(), replayStops: stops }, nightly);
  history.appendCheckpointRun({ ...failure(), status: "success", replayStops: stops }, nightly);
  const attempts = history.readCheckpointRuns(nightly);
  NodeAssert.deepEqual(
    attempts.map(({ attemptOrdinal }) => attemptOrdinal),
    [1, 2, 3],
  );
  NodeAssert.deepEqual(
    attempts.flatMap(({ replayStops }) => replayStops).map(({ group }) => group),
    ["tooling", "incubator"],
  );
});

test("records a fold conflict before throwing the compilation failure", () => {
  const repo = repository();
  write(repo, "x.txt", "base\n");
  const base = commit(repo, "upstream base");
  write(repo, "x.txt", "modified\n");
  commit(repo, "modify x\n\nCarry-Group: incubator");
  git(repo, ["rm", "x.txt"]);
  const source = commit(repo, "delete x\n\nCarry-Group: build-ci");
  NodeAssert.throws(() =>
    replay.compileCarrySetSameBase({
      repo,
      worktree: repo,
      base,
      source,
      preparedPartition: { base, source, head: source },
    }),
  );
  const stops = replay.readCarryReplayStops(repo);
  NodeAssert.equal(stops.length, 1);
  NodeAssert.equal(stops[0].kind, "fold");
  NodeAssert.equal(stops[0].group, "build-ci");
  NodeAssert.deepEqual(stops[0].conflictedPaths, { test: 0, generated: 0, other: 1 });
  const gitDirectory = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const planPath = NodePath.join(gitDirectory, "lastcode-carry-replay-plan.json");
  const plan = JSON.parse(NodeFS.readFileSync(planPath, "utf8"));
  NodeAssert.equal(plan.groupsByCommit[stops[0].commit], "build-ci");
  // Reconstruct a fold whose compiler assigned the pick to a different group.
  plan.groupsByCommit[stops[0].commit] = "tooling";
  NodeFS.writeFileSync(planPath, JSON.stringify(plan));
  const journal = NodePath.join(gitDirectory, "lastcode-carry-replay-stops.jsonl");
  NodeFS.rmSync(journal);
  replay.recordCarryReplayStop(repo);
  NodeAssert.equal(replay.readCarryReplayStops(repo)[0].group, "tooling");
  write(repo, "x.txt", "resolved\n");
  git(repo, ["add", "--all"]);
  NodeFS.rmSync(journal);
  replay.recordCarryReplayStop(repo);
  NodeAssert.deepEqual(replay.readCarryReplayStops(repo), []);
  NodeAssert.deepEqual(replay.readCarryReplayStops(NodePath.join(repo, "absent")), []);
});

test("retains full failed CI labels and excludes blocked checks", async () => {
  const diagnostics = await import("./lib/lastcode-ci-diagnostics.ts");
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-ci-steps-"));
  onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const resultPath = NodePath.join(directory, "failures.json");
  const label = `Workspace tests (@fixture/${"long-name-".repeat(40)})`;
  diagnostics.writeCiFailingSteps(
    [
      { label, status: "failed", error: "truncated error is irrelevant" },
      { label: "Desktop preload bundle assertions", status: "blocked" },
      { label: "Workspace typecheck (@fixture/shared)", status: "failed" },
    ],
    resultPath,
  );
  const failingSteps = JSON.parse(NodeFS.readFileSync(resultPath, "utf8"));
  NodeAssert.deepEqual(failingSteps, [label, "Workspace typecheck (@fixture/shared)"]);
  let ran = false;
  NodeAssert.doesNotThrow(() =>
    diagnostics.withCiFailingSteps(
      () => {
        ran = true;
      },
      {
        createDirectory: () => {
          throw new Error("optional setup unavailable");
        },
      },
    ),
  );
  NodeAssert.equal(ran, true);
  const original = new Error("original validation failure");
  const cleanupFails = {
    createDirectory: () => directory,
    removeDirectory: () => {
      throw new Error("optional cleanup unavailable");
    },
  };
  NodeAssert.throws(
    () =>
      diagnostics.withCiFailingSteps((path) => {
        NodeFS.writeFileSync(path, JSON.stringify(failingSteps));
        throw original;
      }, cleanupFails),
    (error) => error === original,
  );
  NodeAssert.deepEqual(original.failingSteps, failingSteps);
  NodeAssert.doesNotThrow(() => diagnostics.withCiFailingSteps(() => {}, cleanupFails));
  NodeAssert.deepEqual(
    history.checkpointFailureRecord(
      {
        upstreamTag,
        startedAtMs: 1_000,
        commitsRebased: 0,
        error: Object.assign(new Error("validation failed"), { failingSteps }),
      },
      2_000,
    ).failingSteps,
    failingSteps,
  );
});

test("names non-CI failures by their stage without copying error messages", () => {
  for (const [failurePhase, replayMode, expected] of [
    ["rebase", "carry", "Carry replay"],
    ["rebase", "historical", "Historical replay"],
    ["smoke", "carry", "Checkpoint validation"],
    ["publication", "carry", "Checkpoint publication"],
    [undefined, undefined, "Checkpoint attempt"],
  ]) {
    NodeAssert.deepEqual(
      history.checkpointFailureRecord(
        {
          upstreamTag,
          startedAtMs: 1_000,
          commitsRebased: 0,
          failurePhase,
          replayMode,
          error: new Error("a truncated command error..."),
        },
        2_000,
      ).failingSteps,
      [expected],
    );
  }
});

test("historical continuation still records remembered resolutions", () => {
  const repo = repository();
  git(repo, ["config", "rerere.enabled", "true"]);
  write(repo, "x.txt", "base\n");
  const base = commit(repo, "base");
  write(repo, "x.txt", "carry\n");
  commit(repo, "historical change");
  git(repo, ["checkout", "--quiet", "-b", "upstream", base]);
  write(repo, "x.txt", "upstream\n");
  commit(repo, "upstream change");
  git(repo, ["checkout", "--quiet", "main"]);
  NodeAssert.throws(() => git(repo, ["rebase", "upstream"]));
  replay.recordCarryReplayStop(repo, { replayId: "historical-fixture", kind: "replay" });
  NodeFS.rmSync(NodePath.join(repo, ".git", "lastcode-carry-replay-stops.jsonl"));
  write(repo, "x.txt", "resolved\n");
  git(repo, ["add", "--all"]);
  replay.continueCarryReplay(repo);
  const cache = NodePath.join(repo, ".git", "rr-cache");
  NodeAssert.equal(
    NodeFS.readdirSync(cache).some((entry) =>
      NodeFS.existsSync(NodePath.join(cache, entry, "postimage")),
    ),
    true,
  );
});
