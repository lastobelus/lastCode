// @effect-diagnostics nodeBuiltinImport:off -- This test drives disposable Git repositories and checkpoint subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { readCarryGroupChain } from "./lastcode-carry-replay.ts";

const NIGHTLY_A = "v9.9.9-nightly.20990101.1";
const NIGHTLY_B = "v9.9.9-nightly.20990102.2";
const NIGHTLY_C = "v9.9.9-nightly.20990103.3";
const NIGHTLY_D = "v9.9.9-nightly.20990104.4";
const NIGHTLY_E = "v9.9.9-nightly.20990105.5";

interface Fixture {
  readonly home: string;
  readonly origin: string;
  readonly repo: string;
  readonly root: string;
  readonly taskRoot: string;
  readonly upstream: string;
}

const FIXTURE_RUNTIME_PATHS = [
  ".gitignore",
  "package.json",
  "apps/web/src/components/branding/LastCodeWordmark.tsx",
  "packages/shared/src/desktopDistribution.ts",
  "scripts/lastcode-carry-checkpoint.ts",
  "scripts/lastcode-carry-replay.ts",
  "scripts/lastcode-carry-set.json",
  "scripts/lastcode-carry-set.ts",
  "scripts/lastcode-checkpoint-history.ts",
  "scripts/lastcode-checkpoint.ts",
  "scripts/lastcode-lock.mjs",
  "scripts/lastcode-build-mac.ts",
  "scripts/lastcode-nightly.ts",
  "scripts/lib/lastcode-installable-tag.ts",
] as const;

function git(repo: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function gitResult(
  repo: string,
  args: ReadonlyArray<string>,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(repo: string, path: string, contents: string): void {
  const target = NodePath.join(repo, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", subject, ...(body ? ["-m", body] : [])]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function commitTree(repo: string, tree: string, parent: string, message: string): string {
  return git(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], message);
}

function fakeVp(path: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function installFixtureRuntime(fixture: Fixture): void {
  NodeFS.mkdirSync(NodePath.join(fixture.repo, "scripts"), { recursive: true });
  NodeFS.symlinkSync(
    NodePath.join(fixture.taskRoot, "scripts", "node_modules"),
    NodePath.join(fixture.repo, "scripts", "node_modules"),
    "dir",
  );
  fakeVp(NodePath.join(fixture.repo, "node_modules", ".bin", "vp"));
  const fakeBin = NodePath.join(fixture.root, "bin");
  fakeVp(NodePath.join(fakeBin, "osascript"));
}

function initFixture(): Fixture {
  const taskRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-lifecycle-"));
  const repo = NodePath.join(root, "repository");
  const origin = NodePath.join(root, "origin.git");
  const upstream = NodePath.join(root, "upstream.git");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(repo);
  git(repo, ["init", "--quiet", "--initial-branch=fixture"]);
  for (const path of FIXTURE_RUNTIME_PATHS) {
    const target = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(taskRoot, path), target);
  }
  git(repo, ["config", "user.name", "Carry lifecycle test"]);
  git(repo, ["config", "user.email", "carry-lifecycle@localhost"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]);
  git(root, ["init", "--quiet", "--bare", origin]);
  git(root, ["init", "--quiet", "--bare", upstream]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["remote", "add", "upstream", upstream]);
  installFixtureRuntime({ home, origin, repo, root, taskRoot, upstream });
  return { home, origin, repo, root, taskRoot, upstream };
}

function checkpoint(
  fixture: Fixture,
  args: ReadonlyArray<string>,
): NodeChildProcess.SpawnSyncReturns<string> {
  const fakeBin = NodePath.join(fixture.root, "bin");
  return NodeChildProcess.spawnSync(process.execPath, ["scripts/lastcode-checkpoint.ts", ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
}

function checkout(repo: string, branch: string, ref: string): void {
  git(repo, ["checkout", "--quiet", "-B", branch, ref]);
}

function annotatedCheckpoint(
  fixture: Fixture,
  nightly: string,
  commit: string,
  sourceCommit: string,
): string {
  const tag = `lastcode/checkpoint/${nightly}`;
  git(fixture.repo, [
    "tag",
    "--annotate",
    tag,
    commit,
    "--message",
    [
      `LastCode checkpoint for ${nightly}`,
      "",
      `Upstream-Tag: ${nightly}`,
      `Upstream-Commit: ${git(fixture.repo, ["rev-parse", `${nightly}^{commit}`])}`,
      `LastCode-Commit: ${commit}`,
      "Source-Ref: refs/remotes/origin/lastcode/main",
      `Source-Commit: ${sourceCommit}`,
      "Created-At: 2099-01-02T00:00:00.000Z",
    ].join("\n"),
  ]);
  git(fixture.repo, ["push", "--quiet", "origin", tag]);
  return tag;
}

function remoteCommit(remote: string, ref: string): string {
  return git(remote, ["rev-parse", `${ref}^{commit}`]);
}

function remoteMissing(remote: string, ref: string): boolean {
  return gitResult(remote, ["rev-parse", "--verify", ref]).status !== 0;
}

function recoveryWorktree(repo: string): string {
  return NodePath.join(
    NodePath.dirname(repo),
    `${NodePath.basename(repo)}-worktrees`,
    "lastcode-nightly-sync",
  );
}

describe("checkpoint carry lifecycle", () => {
  it("publishes compact revisions, folds a new source PR, and completes retained conflict recovery", () => {
    const fixture = initFixture();
    try {
      const { repo } = fixture;
      git(repo, ["add", "--force", "node_modules/.bin/vp"]);
      const baseA = commit(repo, "fixture upstream base");
      git(repo, ["tag", NIGHTLY_A, baseA]);

      write(repo, "lifecycle-preserved.txt", "latest historical integration resolution\n");
      const partitionA = commit(
        repo,
        "retain historical integration resolution",
        [
          "Carry-Group: tooling",
          "Carry-Fix: fixture#historical-resolution",
          "Carry-Observation: preserve the latest historical checkpoint behavior",
          "Carry-Evidence: fixture://historical-checkpoint-b",
          `Carry-Applies-To: ${NIGHTLY_A}`,
        ].join("\n"),
      );
      const sourceA = commitTree(
        repo,
        git(repo, ["rev-parse", `${partitionA}^{tree}`]),
        baseA,
        "historical LastCode source A",
      );

      checkout(repo, "upstream-main", baseA);
      write(repo, "lifecycle-upstream.txt", "upstream B\n");
      const upstreamB = commit(repo, "upstream B");
      git(repo, ["tag", NIGHTLY_B, upstreamB]);
      git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_A, NIGHTLY_B]);

      checkout(repo, "historical-checkpoint-b", upstreamB);
      write(repo, "lifecycle-preserved.txt", "latest historical integration resolution\n");
      write(repo, "checkpoint-only-resolution.txt", "manual integration resolution on B\n");
      const checkpointB = commit(repo, "historical checkpoint B resolution");
      const historicalTagB = annotatedCheckpoint(fixture, NIGHTLY_B, checkpointB, sourceA);

      checkout(repo, "partition-historical-checkpoint-b", upstreamB);
      write(repo, "lifecycle-preserved.txt", "latest historical integration resolution\n");
      write(repo, "checkpoint-only-resolution.txt", "manual integration resolution on B\n");
      const partitionB = commit(
        repo,
        "retain historical checkpoint B resolution",
        [
          "Carry-Group: tooling",
          "Carry-Fix: fixture#historical-checkpoint-b",
          "Carry-Observation: preserve the latest historical checkpoint tree",
          "Carry-Evidence: fixture://historical-checkpoint-b",
          `Carry-Applies-To: ${NIGHTLY_B}`,
        ].join("\n"),
      );
      assert.equal(
        git(repo, ["rev-parse", `${partitionB}^{tree}`]),
        git(repo, ["rev-parse", `${checkpointB}^{tree}`]),
      );

      checkout(repo, "activation-source", sourceA);
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(repo, "scripts/lastcode-carry-set.json"), "utf8"),
      ) as Record<string, unknown>;
      manifest.replay = {
        mode: "carry",
        bootstrap: {
          base: upstreamB,
          source: checkpointB,
          head: partitionB,
          representedSource: sourceA,
          sourceTag: historicalTagB,
        },
      };
      write(repo, "scripts/lastcode-carry-set.json", `${JSON.stringify(manifest, undefined, 2)}\n`);
      const activationHead = commit(
        repo,
        "activate compact carry replay",
        [
          "Carry-Group: tooling",
          "Carry-Fix: fixture#carry-activation",
          "Carry-Observation: activate from frozen reviewed commits",
          "Carry-Evidence: fixture://carry-activation",
          `Carry-Applies-To: ${NIGHTLY_A}`,
        ].join("\n"),
      );
      const activationRef = `refs/lastcode/carry-sources/pr-1/${activationHead}`;
      git(repo, ["update-ref", activationRef, activationHead]);
      const mainA = commitTree(
        repo,
        git(repo, ["rev-parse", `${activationHead}^{tree}`]),
        sourceA,
        [
          "activate compact carry replay (#1)",
          "",
          `Carry-Source-Ref: ${activationRef}`,
          `Carry-Source-Base: ${sourceA}`,
          `Carry-Source-Head: ${activationHead}`,
        ].join("\n"),
      );
      git(repo, ["update-ref", "refs/heads/lastcode-source", mainA]);
      git(repo, ["push", "--quiet", "origin", `${mainA}:refs/heads/lastcode/main`]);

      const first = checkpoint(fixture, ["--push-tags"]);
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.equal(remoteCommit(fixture.origin, `refs/tags/${historicalTagB}`), checkpointB);
      const revisionB = `lastcode/revision/${NIGHTLY_B}.1`;
      const compactB = remoteCommit(fixture.origin, `refs/tags/${revisionB}`);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), mainA);
      assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_B}.1`), mainA);
      assert.equal(
        git(repo, ["show", `${compactB}:lifecycle-preserved.txt`]),
        "latest historical integration resolution",
      );
      assert.equal(
        git(repo, ["show", `${compactB}:checkpoint-only-resolution.txt`]),
        "manual integration resolution on B",
      );
      assert.equal(readCarryGroupChain(repo, compactB, upstreamB).length, 6);

      checkout(repo, "upstream-main", upstreamB);
      write(repo, "lifecycle-upstream-next.txt", "upstream C\n");
      const upstreamC = commit(repo, "upstream C");
      git(repo, ["tag", NIGHTLY_C, upstreamC]);
      git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_C]);
      checkout(repo, "lastcode-source", mainA);

      const changedUpstream = checkpoint(fixture, ["--push-tags"]);
      assert.equal(changedUpstream.status, 0, changedUpstream.stderr || changedUpstream.stdout);
      const compactC = remoteCommit(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_C}`);
      assert.equal(readCarryGroupChain(repo, compactC, upstreamC).length, 6);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), mainA);

      checkout(repo, "source-pr-2", mainA);
      write(repo, "lifecycle-conflict.txt", "downstream build behavior\n");
      const sourceHead = commit(
        repo,
        "add downstream build behavior",
        [
          "Carry-Group: build-ci",
          "Carry-Fix: fixture#build-behavior",
          "Carry-Observation: this source PR must join the existing compact generation",
          "Carry-Evidence: fixture://source-pr-2",
          `Carry-Applies-To: ${NIGHTLY_C}`,
        ].join("\n"),
      );
      const sourceRef = `refs/lastcode/carry-sources/pr-2/${sourceHead}`;
      git(repo, ["update-ref", sourceRef, sourceHead]);
      const mainWithPr = commitTree(
        repo,
        git(repo, ["rev-parse", `${sourceHead}^{tree}`]),
        mainA,
        [
          "add downstream build behavior (#2)",
          "",
          `Carry-Source-Ref: ${sourceRef}`,
          `Carry-Source-Base: ${mainA}`,
          `Carry-Source-Head: ${sourceHead}`,
        ].join("\n"),
      );
      git(repo, ["update-ref", "refs/heads/lastcode-source", mainWithPr]);
      git(repo, [
        "push",
        "--quiet",
        "origin",
        `${sourceHead}:${sourceRef}`,
        `${mainWithPr}:refs/heads/lastcode/main`,
      ]);
      checkout(repo, "lastcode-source", mainWithPr);

      const folded = checkpoint(fixture, ["--push-tags"]);
      assert.equal(folded.status, 0, folded.stderr || folded.stdout);
      const revisionC = `lastcode/revision/${NIGHTLY_C}.1`;
      const compactWithPr = remoteCommit(fixture.origin, `refs/tags/${revisionC}`);
      const buildGroup = readCarryGroupChain(repo, compactWithPr, upstreamC).find(
        ({ group }) => group === "build-ci",
      );
      assert.equal(buildGroup?.contributions.at(-1)?.sourceCommit, sourceHead);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), mainWithPr);

      const rollbackReason = "verify same-source historical rollback";
      const rollback = checkpoint(fixture, [
        "--push-tags",
        "--replay-mode",
        "historical",
        "--rollback-reason",
        rollbackReason,
      ]);
      assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
      const historicalRevision = `lastcode/revision/${NIGHTLY_C}.2`;
      const historicalRevisionMessage = git(repo, [
        "for-each-ref",
        `refs/tags/${historicalRevision}`,
        "--format=%(contents)",
      ]);
      assert.match(historicalRevisionMessage, /^Replay-Mode: historical$/mu);
      assert.match(
        historicalRevisionMessage,
        /^Rollback-Reason: verify same-source historical rollback$/mu,
      );
      assert.equal(
        remoteCommit(fixture.origin, `refs/tags/${historicalRevision}`),
        git(repo, ["rev-parse", `${historicalRevision}^{commit}`]),
      );

      checkout(repo, "upstream-main", upstreamC);
      write(repo, "lifecycle-conflict.txt", "upstream build behavior\n");
      const upstreamD = commit(repo, "upstream D conflicts with downstream build behavior");
      git(repo, ["tag", NIGHTLY_D, upstreamD]);
      git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_D]);
      checkout(repo, "lastcode-source", mainWithPr);

      const conflicted = checkpoint(fixture, ["--push-tags"]);
      assert.notEqual(conflicted.status, 0);
      const retained = recoveryWorktree(repo);
      assert.equal(NodeFS.existsSync(retained), true);
      assert.match(git(retained, ["status", "--porcelain"]), /lifecycle-conflict\.txt/u);
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_D}`),
        true,
      );
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), mainWithPr);

      write(
        retained,
        "lifecycle-conflict.txt",
        "upstream build behavior\ndownstream build behavior\n",
      );
      git(retained, ["add", "lifecycle-conflict.txt"]);
      NodeChildProcess.execFileSync("git", ["rebase", "--continue"], {
        cwd: retained,
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      fakeVp(NodePath.join(retained, "node_modules", ".bin", "vp"));
      const repairedHead = git(retained, ["rev-parse", "HEAD"]);
      const selected = checkpoint(fixture, [
        "--no-fetch",
        "--select-recovery",
        repairedHead,
        "--recovery-source",
        mainWithPr,
      ]);
      assert.equal(selected.status, 0, selected.stderr || selected.stdout);

      const published = checkpoint(fixture, ["--push-tags", "--promote"]);
      assert.equal(published.status, 0, published.stderr || published.stdout);
      const tagD = `lastcode/checkpoint/${NIGHTLY_D}`;
      const compactD = remoteCommit(fixture.origin, `refs/tags/${tagD}`);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), compactD);
      assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_D}`), mainWithPr);
      assert.equal(NodeFS.existsSync(retained), false);
      assert.equal(readCarryGroupChain(repo, compactD, upstreamD).length, 6);
      assert.equal(
        git(repo, ["show", `${compactD}:lifecycle-conflict.txt`]),
        "upstream build behavior\ndownstream build behavior",
      );

      checkout(repo, "upstream-main", upstreamD);
      write(repo, "lifecycle-upstream-final.txt", "upstream E\n");
      const upstreamE = commit(repo, "upstream E");
      git(repo, ["tag", NIGHTLY_E, upstreamE]);
      git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_E]);
      git(repo, ["push", "--quiet", "origin", `${baseA}:refs/lastcode/sources/${NIGHTLY_E}`]);
      checkout(repo, "lastcode-source", mainWithPr);

      const collision = checkpoint(fixture, ["--push-tags"]);
      assert.notEqual(collision.status, 0);
      assert.match(collision.stderr, /Immutable source ref .* already names/u);
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_E}`),
        true,
      );
      assert.equal(remoteCommit(fixture.origin, `refs/lastcode/sources/${NIGHTLY_E}`), baseA);
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), compactD);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks the first carry revision when it would drop checkpoint-only resolutions", () => {
    const fixture = initFixture();
    try {
      const { repo } = fixture;
      git(repo, ["add", "--force", "node_modules/.bin/vp"]);
      const baseA = commit(repo, "fixture upstream base");
      git(repo, ["tag", NIGHTLY_A, baseA]);

      write(repo, "lifecycle-source.txt", "historical downstream behavior\n");
      const partitionA = commit(
        repo,
        "retain historical downstream behavior",
        "Carry-Group: tooling\n\nCarry-Fix: fixture#historical-source",
      );
      const sourceA = commitTree(
        repo,
        git(repo, ["rev-parse", `${partitionA}^{tree}`]),
        baseA,
        "historical LastCode source A",
      );

      checkout(repo, "upstream-main", baseA);
      write(repo, "lifecycle-upstream.txt", "upstream B\n");
      const upstreamB = commit(repo, "upstream B");
      git(repo, ["tag", NIGHTLY_B, upstreamB]);
      git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_A, NIGHTLY_B]);

      checkout(repo, "historical-checkpoint-b", upstreamB);
      write(repo, "lifecycle-source.txt", "historical downstream behavior\n");
      write(repo, "checkpoint-only-resolution.txt", "manual integration resolution on B\n");
      const checkpointB = commit(repo, "historical checkpoint B with manual resolution");
      const historicalTagB = annotatedCheckpoint(fixture, NIGHTLY_B, checkpointB, sourceA);

      checkout(repo, "activation-source", sourceA);
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(repo, "scripts/lastcode-carry-set.json"), "utf8"),
      ) as Record<string, unknown>;
      manifest.replay = {
        mode: "carry",
        bootstrap: { base: baseA, source: sourceA, head: partitionA },
      };
      write(repo, "scripts/lastcode-carry-set.json", `${JSON.stringify(manifest, undefined, 2)}\n`);
      const activationHead = commit(
        repo,
        "activate compact carry replay",
        "Carry-Group: tooling\n\nCarry-Fix: fixture#carry-activation",
      );
      const activationRef = `refs/lastcode/carry-sources/pr-1/${activationHead}`;
      git(repo, ["update-ref", activationRef, activationHead]);
      const mainA = commitTree(
        repo,
        git(repo, ["rev-parse", `${activationHead}^{tree}`]),
        sourceA,
        [
          "activate compact carry replay (#1)",
          "",
          `Carry-Source-Ref: ${activationRef}`,
          `Carry-Source-Base: ${sourceA}`,
          `Carry-Source-Head: ${activationHead}`,
        ].join("\n"),
      );
      git(repo, ["push", "--quiet", "origin", `${mainA}:refs/heads/lastcode/main`]);

      const result = checkpoint(fixture, ["--push-tags"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /would drop historical integration resolutions/u);
      assert.match(result.stderr, /checkpoint-only-resolution\.txt/u);
      assert.equal(remoteCommit(fixture.origin, `refs/tags/${historicalTagB}`), checkpointB);
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/revision/${NIGHTLY_B}.1`),
        true,
      );
      assert.equal(remoteCommit(fixture.origin, "refs/heads/lastcode/main"), mainA);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fetches remote-only carry refs and validates the exact bootstrap head", () => {
    const fixture = initFixture();
    try {
      const { repo } = fixture;
      git(repo, ["add", "--force", "node_modules/.bin/vp"]);
      const base = commit(repo, "fixture upstream base");
      git(repo, ["tag", NIGHTLY_A, base]);
      git(repo, ["push", "--quiet", "upstream", `${base}:refs/heads/main`, NIGHTLY_A]);

      write(repo, "remote-only-bootstrap.txt", "prepared partition\n");
      const partition = commit(
        repo,
        "prepare remote-only bootstrap partition",
        "Carry-Group: tooling\n\nCarry-Fix: fixture#remote-only-bootstrap",
      );
      const source = commitTree(
        repo,
        git(repo, ["rev-parse", `${partition}^{tree}`]),
        base,
        "historical source",
      );

      checkout(repo, "activation-source", source);
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(repo, "scripts/lastcode-carry-set.json"), "utf8"),
      ) as Record<string, unknown>;
      const bootstrapRef = "refs/lastcode/carry-compiled/bootstrap/remote-only";
      manifest.replay = {
        mode: "carry",
        bootstrap: { base, source, head: partition, ref: bootstrapRef },
      };
      write(repo, "scripts/lastcode-carry-set.json", `${JSON.stringify(manifest, undefined, 2)}\n`);
      const activationHead = commit(
        repo,
        "activate carry replay from remote-only refs",
        "Carry-Group: tooling\n\nCarry-Fix: fixture#remote-only-activation",
      );
      const activationRef = `refs/lastcode/carry-sources/pr-1/${activationHead}`;
      const main = commitTree(
        repo,
        git(repo, ["rev-parse", `${activationHead}^{tree}`]),
        source,
        [
          "activate carry replay from remote-only refs (#1)",
          "",
          `Carry-Source-Ref: ${activationRef}`,
          `Carry-Source-Base: ${source}`,
          `Carry-Source-Head: ${activationHead}`,
        ].join("\n"),
      );
      git(repo, [
        "push",
        "--quiet",
        "origin",
        `${main}:refs/heads/lastcode/main`,
        `${activationHead}:${activationRef}`,
        `${partition}:${bootstrapRef}`,
      ]);

      const freshRepo = NodePath.join(fixture.root, "fresh-repository");
      git(fixture.root, [
        "clone",
        "--quiet",
        "--no-tags",
        "--branch",
        "lastcode/main",
        fixture.origin,
        freshRepo,
      ]);
      git(freshRepo, ["config", "user.name", "Fresh checkpoint test"]);
      git(freshRepo, ["config", "user.email", "fresh-checkpoint@localhost"]);
      git(freshRepo, ["config", "core.hooksPath", "/dev/null"]);
      git(freshRepo, ["remote", "add", "upstream", fixture.upstream]);
      const freshFixture = { ...fixture, repo: freshRepo };
      installFixtureRuntime(freshFixture);

      assert.equal(remoteMissing(freshRepo, activationRef), true);
      assert.equal(remoteMissing(freshRepo, bootstrapRef), true);

      const bootstrapRetained = recoveryWorktree(freshRepo);
      const hooks = NodePath.join(fixture.root, "hooks");
      NodeFS.mkdirSync(hooks);
      NodeFS.writeFileSync(
        NodePath.join(hooks, "pre-push"),
        `#!/bin/sh\necho cleanup-blocker >> ${JSON.stringify(NodePath.join(bootstrapRetained, "remote-only-bootstrap.txt"))}\necho fixture publication failure >&2\nexit 1\n`,
        { mode: 0o755 },
      );
      git(freshRepo, ["config", "core.hooksPath", hooks]);
      const failedBootstrap = checkpoint(freshFixture, ["--push-tags", "--no-smoke"]);
      assert.notEqual(failedBootstrap.status, 0);
      assert.match(failedBootstrap.stderr, /fixture publication failure/u);
      assert.match(failedBootstrap.stderr, /Could not clean failed carry bootstrap/u);
      assert.equal(NodeFS.existsSync(bootstrapRetained), true);
      const failedRun = JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(fixture.home, ".lastcode", "automation", "checkpoint-runs.jsonl"),
          "utf8",
        )
          .trim()
          .split(/\r?\n/u)
          .at(-1) ?? "{}",
      ) as Record<string, unknown>;
      assert.match(String(failedRun.error), /git push .* failed with exit code/u);
      assert.equal(failedRun.recoveryBranch, `sync/nightly/${NIGHTLY_A}`);
      assert.equal(typeof failedRun.recoveryFingerprint, "string");
      assert.equal(
        remoteMissing(fixture.origin, `refs/tags/lastcode/checkpoint/${NIGHTLY_A}`),
        true,
      );

      git(freshRepo, ["config", "core.hooksPath", "/dev/null"]);
      git(freshRepo, ["worktree", "remove", "--force", bootstrapRetained]);
      git(freshRepo, ["update-ref", "-d", `refs/heads/sync/nightly/${NIGHTLY_A}`]);

      const result = checkpoint(freshFixture, ["--no-smoke"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(git(freshRepo, ["rev-parse", `${activationRef}^{commit}`]), activationHead);
      assert.equal(git(freshRepo, ["rev-parse", `${bootstrapRef}^{commit}`]), partition);

      git(freshRepo, ["update-ref", bootstrapRef, base]);
      const mismatch = checkpoint(freshFixture, ["--no-fetch", "--no-smoke"]);
      assert.notEqual(mismatch.status, 0);
      assert.match(
        mismatch.stderr,
        new RegExp(`Carry bootstrap ref .* resolves to ${base}, expected ${partition}`, "u"),
      );
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
