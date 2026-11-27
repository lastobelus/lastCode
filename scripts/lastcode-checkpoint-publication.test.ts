// @effect-diagnostics nodeBuiltinImport:off -- This test drives disposable Git repositories and checkpoint subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { acquireMainWriteLock } from "./lastcode-main-write-lock.ts";
import { readCheckpointRuns, checkpointRunHistoryPath } from "./lastcode-checkpoint-history.ts";
import { inspect } from "./lastcode-local-update.mjs";
import {
  NIGHTLY_A,
  NIGHTLY_B,
  git,
  gitResult,
  write,
  commit,
  checkpoint,
  remoteCommit,
  remoteMissing,
  recoveryWorktree,
  historicalFixture,
} from "./lastcode-checkpoint-lifecycle.fixture.ts";

const UPSTREAM_PINS_PATH = "scripts/lastcode-upstream-imports.json";
const UPSTREAM_PINS = JSON.stringify([
  {
    upstreamRepo: "example/upstream",
    pullRequest: 12,
    pinnedHead: "a".repeat(40),
    trackingRepo: "example/downstream",
    trackingIssue: 34,
  },
]);

describe("checkpoint publication with open PRs", () => {
  it("checks pins from the publishing source and still publishes when GitHub is unavailable", () => {
    const { fixture, queryMarker, environment } = historicalFixture();
    try {
      write(fixture.repo, UPSTREAM_PINS_PATH, UPSTREAM_PINS);
      const source = commit(fixture.repo, "record an upstream import");
      git(fixture.repo, ["push", "--quiet", "origin", `${source}:refs/heads/lastcode/main`]);
      write(fixture.repo, UPSTREAM_PINS_PATH, "uncommitted manifest");

      const preview = checkpoint(fixture, ["--dry-run", "--push-tags"], environment);
      assert.equal(preview.status, 0, preview.stderr || preview.stdout);
      assert.equal(NodeFS.existsSync(queryMarker), false);

      const result = checkpoint(fixture, ["--push-tags"], environment);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /Cannot report example\/upstream\/12/u);
      assert.equal(NodeFS.existsSync(queryMarker), true);
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
        false,
      );
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("retries a failed post-publish command for the already published immutable tag", () => {
    const { fixture, source, environment } = historicalFixture();
    try {
      const automation = NodePath.join(fixture.home, ".lastcode", "automation");
      const command = NodePath.join(fixture.root, "post-publish.mjs");
      const attempts = NodePath.join(fixture.root, "post-publish-attempts");
      const ready = NodePath.join(fixture.root, "post-publish-ready");
      write(
        fixture.root,
        "post-publish.mjs",
        `import { appendFileSync, existsSync } from "node:fs";
const [attempts, ready] = process.argv.slice(2);
const { LASTCODE_CHECKPOINT_TAG: tag, LASTCODE_CHECKPOINT_SHA: sha } = process.env;
appendFileSync(attempts, JSON.stringify({ tag, sha, cwd: process.cwd() }) + "\\n");
if (!existsSync(ready)) process.exitCode = 7;
`,
      );
      NodeFS.mkdirSync(automation, { recursive: true });
      const historyPath = checkpointRunHistoryPath(fixture.home);
      NodeFS.writeFileSync(
        NodePath.join(automation, "checkpoint-supervisor.json"),
        JSON.stringify({
          schemaVersion: 1,
          postPublishCommand: [process.execPath, command, attempts, ready],
        }),
      );
      const tag = `lastcode/checkpoint/${NIGHTLY_B}`;
      const ref = `refs/tags/${tag}`;
      const args = ["--push-tags", "--promote"];
      const serviceEnvironment = {
        ...environment,
        LASTCODE_CHECKPOINT_SUPERVISOR_RUN_ID: "fixture-run",
        LASTCODE_CHECKPOINT_SUPERVISOR_LAUNCHD_PID: "123",
      };
      const eligibleTag = () => {
        const result = inspect({
          command: "inspect",
          repoRoot: fixture.repo,
          home: fixture.home,
          currentVersion: NIGHTLY_A,
        });
        return result.status === "checkpoint-requested" ? undefined : result.checkpointTag;
      };
      const history = () => readCheckpointRuns(historyPath);
      const failed = checkpoint(fixture, args, serviceEnvironment);
      assert.equal(failed.status, 75, failed.stderr || failed.stdout);
      assert.include(failed.stderr, "post-publish");
      const tagObject = git(fixture.origin, ["rev-parse", ref]);
      const sha = remoteCommit(fixture.origin, ref);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
      const readAttempts = () =>
        NodeFS.readFileSync(attempts, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      const expected = { tag, sha, cwd: NodeFS.realpathSync(fixture.repo) };
      assert.deepEqual(readAttempts(), [expected]);
      assert.equal(eligibleTag(), `lastcode/checkpoint/${NIGHTLY_A}`);
      assert.equal(
        history().some((record) => record.status === "success"),
        false,
      );

      const startingHead = git(fixture.repo, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["checkout", "--detach", sha]);
      const bypass = checkpoint(fixture, ["--promote"], environment);
      git(fixture.repo, ["checkout", "--detach", startingHead]);
      assert.equal(bypass.status, 75, bypass.stderr || bypass.stdout);
      assert.include(bypass.stderr, "--push-tags");
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
      assert.deepEqual(readAttempts(), [expected]);

      const upstreamBase = git(fixture.repo, ["rev-parse", NIGHTLY_A]);
      git(fixture.repo, ["push", "origin", `${upstreamBase}:refs/heads/main`]);
      const mirror = checkpoint(fixture, [...args, "--mirror-upstream-main"], environment);
      assert.equal(mirror.status, 75, mirror.stderr || mirror.stdout);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/main"), upstreamBase);

      NodeFS.writeFileSync(ready, "");
      const retry = checkpoint(
        fixture,
        ["--revision-only", NIGHTLY_B, ...args],
        serviceEnvironment,
      );
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.deepEqual(readAttempts(), [expected, expected, expected]);
      assert.equal(git(fixture.origin, ["rev-parse", ref]), tagObject);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), sha);
      assert.equal(eligibleTag(), tag);
      assert.include(history().at(-1), {
        status: "success",
        checkpointTag: tag,
        checkpointCommit: sha,
      });
      const phases = NodeFS.readFileSync(
        NodePath.join(automation, "checkpoint-service-activity.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        phases.map(({ event, phase, outcome }) => [event, phase, outcome]),
        [
          ["phase-start", "post-publish", undefined],
          ["phase-finish", "post-publish", "threw"],
          ["phase-start", "post-publish", undefined],
          ["phase-finish", "post-publish", "returned"],
        ],
      );

      const noOp = checkpoint(fixture, args, environment);
      assert.equal(noOp.status, 0, noOp.stderr || noOp.stdout);
      assert.deepEqual(readAttempts(), [expected, expected, expected]);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes an unchanged annotated upstream nightly using its peeled commit", () => {
    const { fixture, environment } = historicalFixture();
    try {
      const upstreamCommit = git(fixture.repo, ["rev-parse", `${NIGHTLY_B}^{commit}`]);
      git(fixture.repo, [
        "tag",
        "--force",
        "--annotate",
        NIGHTLY_B,
        upstreamCommit,
        "-m",
        "nightly",
      ]);
      git(fixture.repo, ["push", "--force", "upstream", `refs/tags/${NIGHTLY_B}`]);
      assert.notEqual(git(fixture.repo, ["rev-parse", NIGHTLY_B]), upstreamCommit);
      const result = checkpoint(fixture, ["--push-tags"], environment);
      assert.equal(result.status, 0, result.stderr);
      const contents = git(fixture.origin, [
        "for-each-ref",
        "--format=%(contents)",
        `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`,
      ]);
      assert.include(contents, `Upstream-Commit: ${upstreamCommit}`);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["local", "remote"] as const)(
    "retains the pinned candidate after tag movement: %s",
    (location) => {
      const { fixture, source, environment } = historicalFixture();
      try {
        const pinnedUpstream = git(fixture.repo, ["rev-parse", NIGHTLY_B]);
        if (location === "remote") {
          git(fixture.repo, ["push", "upstream", `${source}:refs/heads/fixture-moved-tag`]);
        }
        const result = checkpoint(fixture, ["--push-tags", "--promote"], {
          ...environment,
          FIXTURE_MOVED_NIGHTLY: NIGHTLY_B,
          FIXTURE_NEW_UPSTREAM: source,
          ...(location === "remote" ? { FIXTURE_MOVED_UPSTREAM_REMOTE: fixture.upstream } : {}),
        });
        assert.notEqual(result.status, 0);
        assert.include(result.stderr, `Upstream nightly ${NIGHTLY_B} changed after selection`);
        assert.equal(
          remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
          true,
        );
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
        const retained = recoveryWorktree(fixture.repo);
        assert.equal(NodeFS.existsSync(retained), true);
        assert.equal(
          gitResult(retained, ["merge-base", "--is-ancestor", pinnedUpstream, "HEAD"]).status,
          0,
        );
        assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
        if (location === "remote") {
          assert.equal(git(fixture.repo, ["rev-parse", `${NIGHTLY_B}^{commit}`]), pinnedUpstream);
          assert.equal(remoteCommit(fixture.upstream, `refs/tags/${NIGHTLY_B}`), source);
        }
      } finally {
        NodeFS.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("publishes ordinary tags but reports an unavailable promotion lock, then promotes after release", () => {
    const { fixture, source, merged, queryMarker, environment } = historicalFixture();
    try {
      const lock = acquireMainWriteLock(fixture.repo, "origin", source, "merge");
      try {
        const result = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Could not acquire main write lock/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
        assert.equal(
          remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
          false,
        );
        // Model the guarded merge's final write while the independent checkpoint CLI is excluded.
        git(fixture.repo, ["push", "origin", `${merged}:refs/heads/lastcode/main`]);
      } finally {
        lock.release();
      }
      const retry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      const promoted = remoteCommit(fixture.origin, "refs/heads/lastcode/main");
      assert.equal(
        git(fixture.repo, ["show", `${promoted}:merged-during-checkpoint.txt`]),
        "concurrent merge must survive",
      );
      assert.equal(git(fixture.repo, ["show", `${promoted}:upstream.txt`]), "upstream behavior");
      assert.equal(NodeFS.existsSync(queryMarker), false, "checkpoint must not query the PR queue");
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a pending selected recovery ahead of revision-only publication", () => {
    const { fixture, source, environment } = historicalFixture(true);
    const args = ["--push-tags", "--promote"];
    try {
      assert.notEqual(checkpoint(fixture, args, environment).status, 0);
      const retained = recoveryWorktree(fixture.repo);
      write(retained, "downstream.txt", "upstream behavior\ndownstream behavior\n");
      git(retained, ["add", "downstream.txt"]);
      NodeChildProcess.execFileSync("git", ["rebase", "--continue"], {
        cwd: retained,
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      const repaired = git(retained, ["rev-parse", "HEAD"]);
      const selected = checkpoint(
        fixture,
        ["--no-fetch", "--select-recovery", repaired, "--recovery-source", source],
        environment,
      );
      assert.equal(selected.status, 0, selected.stderr || selected.stdout);
      const ready = NodePath.join(fixture.root, "post-publish-ready");
      write(
        fixture.home,
        ".lastcode/automation/checkpoint-supervisor.json",
        JSON.stringify({
          postPublishCommand: [
            process.execPath,
            "-e",
            'if (!require("node:fs").existsSync(process.argv[1])) process.exitCode = 7;',
            ready,
          ],
        }),
      );
      const result = checkpoint(fixture, args, environment);
      assert.equal(result.status, 75, result.stderr || result.stdout);
      const tagRef = `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`;
      const tagObject = git(fixture.origin, ["rev-parse", tagRef]);
      assert.equal(remoteCommit(fixture.origin, tagRef), repaired);
      NodeFS.writeFileSync(ready, "");
      write(retained, "second-repair.txt", "another repair\n");
      git(retained, ["add", "second-repair.txt"]);
      git(retained, ["commit", "--message", "another repair"]);
      const replacement = git(retained, ["rev-parse", "HEAD"]);
      const reselection = checkpoint(
        fixture,
        ["--no-fetch", "--select-recovery", replacement, "--recovery-source", source],
        environment,
      );
      assert.equal(reselection.status, 75, reselection.stderr || reselection.stdout);
      assert.include(reselection.stderr, "before changing its selection");
      git(retained, ["reset", "--hard", repaired]);
      const revision = checkpoint(fixture, ["--revision-only", NIGHTLY_B, ...args], environment);
      assert.equal(revision.status, 75, revision.stderr || revision.stdout);
      assert.include(revision.stderr, "pending selected checkpoint recovery");
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
      assert.equal(NodeFS.existsSync(retained), true);

      const retry = checkpoint(fixture, args, environment);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), repaired);
      assert.equal(git(fixture.origin, ["rev-parse", tagRef]), tagObject);
      assert.equal(NodeFS.existsSync(retained), false);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes selected recovery but reports an unavailable promotion lock, then promotes after release", () => {
    const { fixture, source, queryMarker, environment } = historicalFixture(true);
    try {
      const failed = checkpoint(fixture, ["--push-tags", "--promote"], environment);
      assert.notEqual(failed.status, 0);
      const retained = recoveryWorktree(fixture.repo);
      assert.equal(NodeFS.existsSync(retained), true, failed.stderr || failed.stdout);
      write(retained, "downstream.txt", "upstream behavior\ndownstream behavior\n");
      git(retained, ["add", "downstream.txt"]);
      NodeChildProcess.execFileSync("git", ["rebase", "--continue"], {
        cwd: retained,
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      const repaired = git(retained, ["rev-parse", "HEAD"]);
      const selected = checkpoint(
        fixture,
        ["--no-fetch", "--select-recovery", repaired, "--recovery-source", source],
        environment,
      );
      assert.equal(selected.status, 0, selected.stderr || selected.stdout);
      const selectionPath = NodePath.join(
        git(fixture.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        "lastcode-recovery-selection.json",
      );
      const tagRef = `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`;
      const sourceRef = `refs/lastcode/sources/${NIGHTLY_B}`;
      const selectionContents = NodeFS.readFileSync(selectionPath, "utf8");
      const lock = acquireMainWriteLock(fixture.repo, "origin", source, "merge");
      let publishedTag = "";
      try {
        const result = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Could not acquire main write lock/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
        assert.equal(remoteCommit(fixture.origin, tagRef), repaired);
        assert.equal(remoteCommit(fixture.origin, sourceRef), source);
        publishedTag = git(fixture.origin, ["rev-parse", tagRef]);
        assert.equal(NodeFS.existsSync(retained), true);
        assert.equal(git(retained, ["rev-parse", "HEAD"]), repaired);
        assert.equal(NodeFS.readFileSync(selectionPath, "utf8"), selectionContents);
      } finally {
        lock.release();
      }
      // With main still at the repair's source, the next run promotes the published tag.
      const retry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), repaired);
      assert.equal(remoteCommit(fixture.origin, tagRef), repaired);
      assert.equal(git(fixture.origin, ["rev-parse", tagRef]), publishedTag);
      assert.equal(NodeFS.existsSync(retained), false);
      assert.equal(NodeFS.existsSync(selectionPath), false);
      assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
      assert.equal(NodeFS.existsSync(queryMarker), false, "recovery must not query the PR queue");
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["Authentication failed", "Connection reset by peer", "remote rejected lock ref"])(
    "reports lock acquisition failure after publishing the tag: %s",
    (failure) => {
      const { fixture, source, environment } = historicalFixture();
      try {
        const realGit = NodeChildProcess.execFileSync("which", ["git"], {
          encoding: "utf8",
        }).trim();
        NodeFS.writeFileSync(
          NodePath.join(fixture.root, "bin", "git"),
          `#!/bin/sh
if [ "$1" = push ]; then
  case "$*" in
    *:refs/lastcode/main-write-lock*)
      echo "fatal: $FIXTURE_LOCK_FAILURE" >&2
      exit 128
      ;;
  esac
fi
exec "${realGit}" "$@"
`,
          { mode: 0o755 },
        );
        const result = checkpoint(fixture, ["--push-tags", "--promote"], {
          ...environment,
          FIXTURE_LOCK_FAILURE: failure,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Could not acquire main write lock/u);
        assert.include(result.stderr, failure);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), source);
        assert.equal(
          remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
          false,
        );
      } finally {
        NodeFS.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("prepares the candidate from its pinned source when the tracking ref changes", () => {
    const { fixture, source, merged, environment } = historicalFixture();
    try {
      const realGit = NodeChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const marker = NodePath.join(fixture.root, "tracking-ref-moved");
      NodeFS.writeFileSync(
        NodePath.join(fixture.root, "bin", "git"),
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ]; then
  "$FIXTURE_REAL_GIT" update-ref refs/remotes/origin/lastcode/main "$FIXTURE_MERGE_COMMIT" || exit 1
  touch "$FIXTURE_TRACKING_MARKER"
fi
exec "$FIXTURE_REAL_GIT" "$@"
`,
        { mode: 0o755 },
      );
      const result = checkpoint(fixture, ["--push-tags", "--promote"], {
        ...environment,
        FIXTURE_REAL_GIT: realGit,
        FIXTURE_MERGE_COMMIT: merged,
        FIXTURE_TRACKING_MARKER: marker,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(NodeFS.existsSync(marker), true);
      const tag = `lastcode/checkpoint/${NIGHTLY_B}`;
      const candidate = remoteCommit(fixture.origin, `refs/tags/${tag}`);
      assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}`), source);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), candidate);
      assert.notEqual(
        gitResult(fixture.repo, ["cat-file", "-e", `${candidate}:merged-during-checkpoint.txt`])
          .status,
        0,
      );
      assert.equal(
        git(fixture.repo, ["show", `${candidate}:downstream.txt`]),
        "downstream behavior",
      );
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(
    (["none", "smoke", "push"] as const).map((phase) => ({
      phase,
      name: `publishes historical checkpoints with open PRs${phase !== "none" ? ` and defers promotion past a merge during ${phase}` : ""}`,
    })),
  )("$name", ({ phase }) => {
    const concurrentMerge = phase !== "none";
    const { fixture, source, merged, queryMarker, environment, raceEnvironment } =
      historicalFixture();
    try {
      const result = checkpoint(
        fixture,
        ["--push-tags", "--promote"],
        concurrentMerge ? { ...raceEnvironment, FIXTURE_MERGE_PHASE: phase } : environment,
      );
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
        false,
        result.stderr || result.stdout,
      );
      const tag = `lastcode/checkpoint/${NIGHTLY_B}`;
      const candidate = remoteCommit(fixture.origin, `refs/tags/${tag}`);
      assert.equal(
        git(fixture.repo, ["show", `${candidate}:downstream.txt`]),
        "downstream behavior",
      );
      assert.equal(git(fixture.repo, ["show", `${candidate}:upstream.txt`]), "upstream behavior");
      if (concurrentMerge) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /leaving promotion to a later admitted run/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), merged);
        const retry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.equal(retry.status, 0, retry.stderr || retry.stdout);
        const promoted = remoteCommit(fixture.origin, "refs/heads/lastcode/main");
        assert.equal(
          git(fixture.repo, ["show", `${promoted}:merged-during-checkpoint.txt`]),
          "concurrent merge must survive",
        );
        assert.equal(git(fixture.repo, ["show", `${promoted}:upstream.txt`]), "upstream behavior");
        assert.equal(remoteCommit(fixture.origin, `refs/tags/${tag}`), candidate);
        assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}.1`), merged);
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), candidate);
        assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}`), source);
      }
      assert.equal(NodeFS.existsSync(queryMarker), false, "checkpoint must not query the PR queue");
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["smoke", "push"] as const)(
    "publishes the checkpoint but rejects promotion after main is rewritten during %s",
    (phase) => {
      const { fixture, source, raceEnvironment } = historicalFixture();
      try {
        const rewritten = git(
          fixture.origin,
          [
            "-c",
            "user.name=Carry lifecycle test",
            "-c",
            "user.email=carry-lifecycle@localhost",
            "commit-tree",
            git(fixture.origin, ["rev-parse", `${source}^{tree}`]),
            "-F",
            "-",
          ],
          "Rewritten main with unrelated history\n",
        );
        // The push race must discover a remote commit that was not fetched earlier.
        assert.notEqual(gitResult(fixture.repo, ["cat-file", "-e", rewritten]).status, 0);
        const result = checkpoint(fixture, ["--push-tags", "--promote"], {
          ...raceEnvironment,
          FIXTURE_MERGE_PHASE: phase,
          FIXTURE_MERGE_COMMIT: rewritten,
        });
        assert.equal(NodeFS.existsSync(raceEnvironment.FIXTURE_MERGE_MARKER), true);
        assert.equal(
          remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
          false,
          result.stderr || result.stdout,
        );
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stderr, /refusing stale promotion/u);
        assert.notMatch(result.stdout, /leaving promotion to a later admitted run/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), rewritten);
        assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
      } finally {
        NodeFS.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["smoke", "push"] as const)(
    "retains selected recovery after main is rewritten during %s and promotes it after main is restored",
    (phase) => {
      const { fixture, source, queryMarker, environment, raceEnvironment } =
        historicalFixture(true);
      try {
        const failed = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.notEqual(failed.status, 0);
        const retained = recoveryWorktree(fixture.repo);
        assert.equal(NodeFS.existsSync(retained), true, failed.stderr || failed.stdout);
        write(retained, "downstream.txt", "upstream behavior\ndownstream behavior\n");
        git(retained, ["add", "downstream.txt"]);
        NodeChildProcess.execFileSync("git", ["rebase", "--continue"], {
          cwd: retained,
          env: { ...process.env, GIT_EDITOR: "true" },
        });
        const repaired = git(retained, ["rev-parse", "HEAD"]);
        const selected = checkpoint(
          fixture,
          ["--no-fetch", "--select-recovery", repaired, "--recovery-source", source],
          environment,
        );
        assert.equal(selected.status, 0, selected.stderr || selected.stdout);
        const selectionPath = NodePath.join(
          git(fixture.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
          "lastcode-recovery-selection.json",
        );
        const selectionContents = NodeFS.readFileSync(selectionPath, "utf8");
        const rewritten = git(
          fixture.origin,
          [
            "-c",
            "user.name=Carry lifecycle test",
            "-c",
            "user.email=carry-lifecycle@localhost",
            "commit-tree",
            git(fixture.origin, ["rev-parse", `${source}^{tree}`]),
            "-F",
            "-",
          ],
          "Rewritten main with unrelated history\n",
        );
        assert.notEqual(gitResult(fixture.repo, ["cat-file", "-e", rewritten]).status, 0);
        const result = checkpoint(fixture, ["--push-tags", "--promote"], {
          ...raceEnvironment,
          FIXTURE_MERGE_PHASE: phase,
          FIXTURE_MERGE_COMMIT: rewritten,
        });
        assert.equal(NodeFS.existsSync(raceEnvironment.FIXTURE_MERGE_MARKER), true);
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stderr, /refusing stale promotion/u);
        const tagRef = `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`;
        const sourceRef = `refs/lastcode/sources/${NIGHTLY_B}`;
        assert.equal(remoteCommit(fixture.origin, tagRef), repaired);
        assert.equal(remoteCommit(fixture.origin, sourceRef), source);
        const publishedRefs = git(fixture.origin, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/tags/lastcode/checkpoint/",
          "refs/lastcode/sources/",
        ]);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), rewritten);
        assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
        assert.equal(NodeFS.existsSync(retained), true);
        assert.equal(git(retained, ["rev-parse", "HEAD"]), repaired);
        assert.equal(NodeFS.readFileSync(selectionPath, "utf8"), selectionContents);

        const blockedRetry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.notEqual(blockedRetry.status, 0, blockedRetry.stderr || blockedRetry.stdout);
        assert.match(blockedRetry.stderr, /Published recovery is not represented on main/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), rewritten);
        assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
        assert.equal(NodeFS.existsSync(retained), true);
        assert.equal(git(retained, ["rev-parse", "HEAD"]), repaired);
        assert.equal(NodeFS.readFileSync(selectionPath, "utf8"), selectionContents);
        assert.equal(
          git(fixture.origin, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/lastcode/checkpoint/",
            "refs/lastcode/sources/",
          ]),
          publishedRefs,
        );

        git(fixture.origin, ["update-ref", "refs/heads/lastcode/main", source, rewritten]);
        const retry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.equal(retry.status, 0, retry.stderr || retry.stdout);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), repaired);
        assert.equal(
          git(fixture.origin, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/lastcode/checkpoint/",
            "refs/lastcode/sources/",
          ]),
          publishedRefs,
        );
        assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
        assert.equal(NodeFS.existsSync(retained), false);
        assert.equal(NodeFS.existsSync(selectionPath), false);
        assert.equal(NodeFS.existsSync(queryMarker), false, "recovery must not query the PR queue");
      } finally {
        NodeFS.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("defers promotion after a remote-only descendant arrives during push", () => {
    const { fixture, source, raceEnvironment } = historicalFixture();
    try {
      const descendant = git(
        fixture.origin,
        [
          "-c",
          "user.name=Carry lifecycle test",
          "-c",
          "user.email=carry-lifecycle@localhost",
          "commit-tree",
          git(fixture.origin, ["rev-parse", `${source}^{tree}`]),
          "-p",
          source,
          "-F",
          "-",
        ],
        "Concurrent remote main update\n",
      );
      assert.notEqual(gitResult(fixture.repo, ["cat-file", "-e", descendant]).status, 0);
      // Route a GitHub push URL to the local origin so promotion approves the candidate.
      const statusLog = NodePath.join(fixture.root, "guard-statuses");
      const ssh = NodePath.join(fixture.root, "bin", "ssh");
      NodeFS.writeFileSync(
        ssh,
        `#!/bin/sh\nfor last; do :; done\ncase "$last" in git-receive-pack*) exec git receive-pack "${fixture.origin}";; esac\nexit 1\n`,
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(fixture.root, "bin", "gh"),
        `#!/bin/sh\ncase "$*" in *statuses/*) printf '%s\\n' "$*" >> "${statusLog}"; exit 0;; esac\ntouch "$FIXTURE_PR_QUERY"\necho '[{"number":209}]'\nexit 1\n`,
        { mode: 0o755 },
      );
      git(fixture.repo, [
        "remote",
        "set-url",
        "--push",
        "origin",
        "git@github.com:example/repository.git",
      ]);
      const result = checkpoint(fixture, ["--push-tags", "--promote"], {
        ...raceEnvironment,
        FIXTURE_MERGE_PHASE: "push",
        FIXTURE_MERGE_COMMIT: descendant,
        GIT_SSH_COMMAND: ssh,
      });
      assert.equal(NodeFS.existsSync(raceEnvironment.FIXTURE_MERGE_MARKER), true);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /leaving promotion to a later admitted run/u);
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_B}`),
        false,
      );
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), descendant);
      assert.equal(remoteMissing(fixture.origin, "refs/lastcode/main-write-lock"), true);
      const candidate = remoteCommit(fixture.origin, "refs/lastcode/main-write-candidate");
      assert.deepEqual(
        NodeFS.readFileSync(statusLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => /statuses\/(\w+) -f (state=\w+)/u.exec(line)?.slice(1).join(" ")),
        [`${candidate} state=success`, `${candidate} state=failure`],
      );
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(
    (["none", "selected", "smoke", "push"] as const).map((phase) => ({
      phase,
      name: `publishes selected recovery with open PRs${phase !== "none" ? ` and retains pending promotion after a merge made ${phase === "selected" ? "after selection" : `during ${phase}`}` : ""}`,
    })),
  )("selected repair: $name", ({ phase }) => {
    const concurrentMerge = phase !== "none";
    const {
      fixture,
      source,
      merged: fixtureMerge,
      queryMarker,
      environment,
      raceEnvironment,
    } = historicalFixture(true);
    let merged = fixtureMerge;
    try {
      const failed = checkpoint(fixture, ["--push-tags", "--promote"], environment);
      assert.notEqual(failed.status, 0);
      const retained = recoveryWorktree(fixture.repo);
      assert.equal(NodeFS.existsSync(retained), true, failed.stderr || failed.stdout);
      assert.match(git(retained, ["status", "--porcelain"]), /downstream\.txt/u);
      write(retained, "downstream.txt", "upstream behavior\ndownstream behavior\n");
      git(retained, ["add", "downstream.txt"]);
      NodeChildProcess.execFileSync("git", ["rebase", "--continue"], {
        cwd: retained,
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      const repaired = git(retained, ["rev-parse", "HEAD"]);
      const selected = checkpoint(
        fixture,
        ["--no-fetch", "--select-recovery", repaired, "--recovery-source", source],
        environment,
      );
      assert.equal(selected.status, 0, selected.stderr || selected.stdout);
      const selectionPath = NodePath.join(
        git(fixture.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        "lastcode-recovery-selection.json",
      );
      assert.equal(NodeFS.existsSync(selectionPath), true);
      if (phase === "selected") {
        git(fixture.repo, ["switch", "--detach", merged]);
        write(fixture.repo, UPSTREAM_PINS_PATH, UPSTREAM_PINS);
        git(fixture.repo, ["add", UPSTREAM_PINS_PATH]);
        git(fixture.repo, ["commit", "--amend", "--no-edit"]);
        merged = git(fixture.repo, ["rev-parse", "HEAD"]);
        git(fixture.repo, ["push", "--quiet", "origin", `${merged}:refs/heads/lastcode/main`]);
        git(fixture.repo, ["switch", "lastcode-source"]);
      }
      const result = checkpoint(
        fixture,
        ["--push-tags", "--promote"],
        phase === "smoke" || phase === "push"
          ? { ...raceEnvironment, FIXTURE_MERGE_PHASE: phase }
          : environment,
      );
      assert.equal(
        NodeFS.existsSync(queryMarker),
        false,
        "recovery must use the selected source's pins",
      );
      const tag = `lastcode/checkpoint/${NIGHTLY_B}`;
      if (concurrentMerge) {
        // Publication succeeds, but the selected repair cannot discard the new main work.
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.match(result.stderr, /promotion is still pending/u);
        assert.match(result.stderr, /Retained the selected target and recovery worktree/u);
        assert.equal(remoteCommit(fixture.origin, `refs/tags/${tag}`), repaired);
        assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}`), source);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), merged);
        assert.equal(NodeFS.existsSync(retained), true);
        const pendingSelection = NodeFS.readFileSync(selectionPath, "utf8");
        const immutableTag = git(fixture.origin, ["rev-parse", `refs/tags/${tag}`]);
        const retry = checkpoint(fixture, ["--push-tags", "--promote"], environment);
        assert.equal(retry.status, 1, retry.stderr || retry.stdout);
        assert.match(retry.stderr, /promotion is still pending/u);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), merged);
        assert.equal(
          remoteMissing(fixture.origin, `refs/tags/lastcode/revision/${NIGHTLY_B}.1`),
          true,
        );
        assert.equal(NodeFS.readFileSync(selectionPath, "utf8"), pendingSelection);
        assert.equal(git(retained, ["rev-parse", "HEAD"]), repaired);
        assert.equal(git(fixture.origin, ["rev-parse", `refs/tags/${tag}`]), immutableTag);
        assert.equal(remoteCommit(fixture.origin, `refs/tags/${tag}`), repaired);
        if (phase === "selected") {
          // The operator incorporates the later source, then explicitly selects the revised target.
          git(retained, ["cherry-pick", merged]);
          const incorporated = git(retained, ["rev-parse", "HEAD"]);
          const reselected = checkpoint(
            fixture,
            ["--select-recovery", incorporated, "--recovery-source", merged],
            environment,
          );
          assert.equal(reselected.status, 0, reselected.stderr || reselected.stdout);
          const resumed = checkpoint(fixture, ["--push-tags", "--promote"], environment);
          assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
          assert.match(resumed.stderr, /Cannot report example\/upstream\/12/u);
          assert.equal(NodeFS.existsSync(queryMarker), true);
          assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), incorporated);
          assert.equal(
            remoteCommit(fixture.origin, `refs/tags/lastcode/revision/${NIGHTLY_B}.1`),
            incorporated,
          );
          assert.equal(
            remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}.1`),
            merged,
          );
          assert.equal(git(fixture.origin, ["rev-parse", `refs/tags/${tag}`]), immutableTag);
          assert.equal(
            git(fixture.repo, ["show", `${incorporated}:merged-during-checkpoint.txt`]),
            "concurrent merge must survive",
          );
          assert.equal(NodeFS.existsSync(retained), false);
          assert.equal(NodeFS.existsSync(selectionPath), false);
        }
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(remoteCommit(fixture.origin, `refs/tags/${tag}`), repaired);
        assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), repaired);
        assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}`), source);
        assert.equal(NodeFS.existsSync(retained), false);
        assert.equal(NodeFS.existsSync(selectionPath), false);
      }
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
