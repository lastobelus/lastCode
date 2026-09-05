// @effect-diagnostics nodeBuiltinImport:off -- These tests build disposable Git repositories.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CARRY_REPLAY_GROUPS,
  compileCarrySetSameBase,
  completeCarryReplay,
  expandCarrySource,
  readCarryGroupChain,
  readCarryReplayPlan,
  replayCarrySetOnto,
  replayUngroupedOnto,
} from "./lastcode-carry-replay.ts";

function git(repo: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
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

function initRepo(): { readonly repo: string; readonly cleanup: () => void } {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-replay-test-"));
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Carry replay test"]);
  git(repo, ["config", "user.email", "carry-replay-test@localhost"]);
  return { repo, cleanup: () => NodeFS.rmSync(repo, { recursive: true, force: true }) };
}

function prepareBootstrap(repo: string): {
  readonly base: string;
  readonly historicalSource: string;
  readonly partition: string;
} {
  write(
    repo,
    "shared.txt",
    "actions=off\ncontext-1\ncontext-2\ncontext-3\ncontext-4\ncontext-5\ncontext-6\nsidebar=off\n",
  );
  write(repo, "old-name.txt", "rename me\n");
  write(repo, "delete-me.txt", "delete me\n");
  const base = commit(repo, "upstream A");

  write(
    repo,
    "shared.txt",
    "actions=off\ncontext-1\ncontext-2\ncontext-3\ncontext-4\ncontext-5\ncontext-6\nsidebar=visible\n",
  );
  commit(
    repo,
    "show action visibility",
    [
      "Carry-Group: legacy-sidebar",
      "Carry-Fix: lastcode#sidebar",
      "Carry-Observation: visibility is optional while action execution remains essential",
      "Carry-Evidence: fixture://shared-file",
      "Carry-Applies-To: upstream-a",
    ].join("\n"),
  );

  write(
    repo,
    "shared.txt",
    "actions=resumable\ncontext-1\ncontext-2\ncontext-3\ncontext-4\ncontext-5\ncontext-6\nsidebar=visible\n",
  );
  git(repo, ["mv", "old-name.txt", "new-name.txt"]);
  git(repo, ["rm", "--quiet", "delete-me.txt"]);
  const partition = commit(
    repo,
    "make actions resumable",
    [
      "Carry-Group: resumable-actions",
      "Carry-Fix: lastcode#actions",
      "Carry-Upstream: https://example.invalid/upstream/actions@abc123",
      "Carry-Observation: recovery keeps the resolved action state",
      "Carry-Evidence: fixture://rename-delete",
      "Carry-Applies-To: upstream-a",
      "Carry-Supersedes: lastcode#older-actions",
    ].join("\n"),
  );
  const historicalSource = commitTree(
    repo,
    git(repo, ["rev-parse", `${partition}^{tree}`]),
    base,
    "historical mixed squash",
  );
  return { base, historicalSource, partition };
}

function checkout(repo: string, branch: string, commit: string): void {
  git(repo, ["checkout", "--quiet", "-B", branch, commit]);
}

function makePartitionedSquash(
  repo: string,
  base: string,
  changes: () => void,
): { readonly head: string; readonly squash: string; readonly sourceRef: string } {
  checkout(repo, "pr-source", base);
  changes();
  const actionCommit = commit(
    repo,
    "extend resumable actions",
    [
      "Carry-Group: resumable-actions",
      "Carry-Fix: lastcode#next-actions",
      "Carry-Observation: the second generation keeps prior repairs",
      "Carry-Evidence: fixture://second-generation",
      "Carry-Applies-To: upstream-a",
    ].join("\n"),
  );
  write(
    repo,
    "shared.txt",
    `${NodeFS.readFileSync(NodePath.join(repo, "shared.txt"), "utf8")}badge=shown\n`,
  );
  const head = commit(
    repo,
    "show resumed action badge",
    [
      "Carry-Group: legacy-sidebar",
      "Carry-Fix: lastcode#next-sidebar",
      "Carry-Observation: sidebar rendering follows the action capability",
      "Carry-Evidence: fixture://second-generation",
      "Carry-Applies-To: upstream-a",
    ].join("\n"),
  );
  assert.notEqual(actionCommit, head);
  const sourceRef = `refs/lastcode/carry-sources/pr-2/${head}`;
  git(repo, ["update-ref", sourceRef, head]);
  const squash = commitTree(
    repo,
    git(repo, ["rev-parse", `${head}^{tree}`]),
    base,
    [
      "add resumed action UI (#2)",
      "",
      `Carry-Source-Ref: ${sourceRef}`,
      `Carry-Source-Base: ${base}`,
      `Carry-Source-Head: ${head}`,
    ].join("\n"),
  );
  return { head, squash, sourceRef };
}

describe("carry replay core", () => {
  it("compacts a frozen bootstrap partition plus a newer multi-group squash", () => {
    const { repo, cleanup } = initRepo();
    try {
      const bootstrap = prepareBootstrap(repo);
      const pr = makePartitionedSquash(repo, bootstrap.historicalSource, () => {
        write(repo, "post-bootstrap.txt", "included after the frozen bootstrap source\n");
      });
      checkout(repo, "compile-bootstrap", pr.squash);
      const result = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: bootstrap.base,
        source: pr.squash,
        preparedPartition: {
          base: bootstrap.base,
          source: bootstrap.historicalSource,
          head: bootstrap.partition,
        },
      });

      assert.equal(git(repo, ["branch", "--show-current"]), "compile-bootstrap");
      assert.equal(result.groups?.length, CARRY_REPLAY_GROUPS.length);
      assert.equal(
        git(repo, ["rev-parse", `${result.head}^{tree}`]),
        git(repo, ["rev-parse", `${pr.squash}^{tree}`]),
      );
      assert.equal(NodeFS.existsSync(NodePath.join(repo, "old-name.txt")), false);
      assert.equal(NodeFS.existsSync(NodePath.join(repo, "new-name.txt")), true);
      assert.equal(NodeFS.existsSync(NodePath.join(repo, "delete-me.txt")), false);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "post-bootstrap.txt"), "utf8"),
        "included after the frozen bootstrap source\n",
      );
      const groups = readCarryGroupChain(repo, result.head, bootstrap.base);
      const actions = groups.find(({ group }) => group === "resumable-actions");
      const sidebar = groups.find(({ group }) => group === "legacy-sidebar");
      assert.equal(actions?.contributions[0]?.metadata["Carry-Fix"][0], "lastcode#actions");
      assert.equal(
        actions?.contributions[0]?.metadata["Carry-Supersedes"][0],
        "lastcode#older-actions",
      );
      assert.equal(
        actions?.contributions[0]?.metadata["Carry-Observation"][0],
        "recovery keeps the resolved action state",
      );
      assert.equal(sidebar?.contributions[0]?.metadata["Carry-Fix"][0], "lastcode#sidebar");
      assert.equal(actions?.contributions.length, 2);
      assert.equal(sidebar?.contributions.length, 2);
      assert.equal(
        groups.find(({ group }) => group === "upstream-bugfixes")?.contributions.length,
        0,
      );
      assert.equal(readCarryReplayPlan(repo)?.status, "complete");
    } finally {
      cleanup();
    }
  });

  it("keeps globally enabled rerere out of carry replay while retaining explicit conflict recovery", () => {
    const { repo, cleanup } = initRepo();
    try {
      git(repo, ["config", "rerere.enabled", "true"]);
      git(repo, ["config", "rerere.autoupdate", "true"]);
      const bootstrap = prepareBootstrap(repo);
      checkout(repo, "compile", bootstrap.historicalSource);
      const compact = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: bootstrap.base,
        source: bootstrap.historicalSource,
        preparedPartition: {
          base: bootstrap.base,
          source: bootstrap.historicalSource,
          head: bootstrap.partition,
        },
      }).head;

      checkout(repo, "upstream-adopts-actions", bootstrap.base);
      git(repo, ["read-tree", "--reset", "-u", bootstrap.historicalSource]);
      const adoptedUpstream = commit(repo, "upstream adopts the carried actions");
      checkout(repo, "replay-adopted", compact);
      const adopted = replayCarrySetOnto({
        repo,
        worktree: repo,
        sourceBase: bootstrap.base,
        compactHead: compact,
        onto: adoptedUpstream,
      });
      const adoptedActions = readCarryGroupChain(repo, adopted.head, adoptedUpstream).find(
        ({ group }) => group === "resumable-actions",
      );
      assert.equal(adoptedActions?.contributions[0]?.sourceCommit, bootstrap.partition);
      assert.equal(
        adoptedActions?.contributions[0]?.metadata["Carry-Supersedes"][0],
        "lastcode#older-actions",
      );

      checkout(repo, "upstream-b", bootstrap.base);
      write(repo, "upstream-only.txt", "from B\n");
      const upstreamB = commit(repo, "upstream B non-overlap");
      checkout(repo, "replay-b", compact);
      const replayed = replayCarrySetOnto({
        repo,
        worktree: repo,
        sourceBase: bootstrap.base,
        compactHead: compact,
        onto: upstreamB,
      });
      assert.equal(
        readCarryGroupChain(repo, replayed.head, upstreamB).length,
        CARRY_REPLAY_GROUPS.length,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "upstream-only.txt"), "utf8"),
        "from B\n",
      );
      assert.match(
        readCarryGroupChain(repo, replayed.head, upstreamB).find(
          ({ group }) => group === "resumable-actions",
        )?.contributions[0]?.metadata["Carry-Observation"][0] ?? "",
        /resolved action state/u,
      );

      checkout(repo, "upstream-conflict", bootstrap.base);
      write(
        repo,
        "shared.txt",
        NodeFS.readFileSync(NodePath.join(repo, "shared.txt"), "utf8").replace(
          /^actions=.*$/mu,
          "actions=upstream",
        ),
      );
      const conflictingUpstream = commit(repo, "upstream conflicts with actions");
      checkout(repo, "replay-conflict", compact);
      assert.throws(() =>
        replayCarrySetOnto({
          repo,
          worktree: repo,
          sourceBase: bootstrap.base,
          compactHead: compact,
          onto: conflictingUpstream,
        }),
      );
      assert.equal(readCarryReplayPlan(repo)?.phase, "replay");
      assert.equal(readCarryReplayPlan(repo)?.status, "running");
      const gitDirectory = git(repo, ["rev-parse", "--absolute-git-dir"]);
      assert.equal(NodeFS.existsSync(NodePath.join(gitDirectory, "rebase-merge")), true);
      assert.equal(NodeFS.existsSync(NodePath.join(gitDirectory, "MERGE_RR")), false);
      assert.equal(NodeFS.existsSync(NodePath.join(gitDirectory, "MERGE_RR.lock")), false);
      assert.throws(() => completeCarryReplay(repo), /unresolved rebase state/u);
      write(
        repo,
        "shared.txt",
        NodeFS.readFileSync(NodePath.join(repo, "shared.txt"), "utf8").replace(
          /^actions=.*$/mu,
          "actions=resumable",
        ),
      );
      git(repo, ["add", "shared.txt"]);
      git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
      const recovered = completeCarryReplay(repo);
      assert.equal(readCarryGroupChain(repo, recovered.head, conflictingUpstream).length, 6);
      assert.match(
        readCarryGroupChain(repo, recovered.head, conflictingUpstream).find(
          ({ group }) => group === "resumable-actions",
        )?.contributions[0]?.metadata["Carry-Observation"][0] ?? "",
        /resolved action state/u,
      );
    } finally {
      cleanup();
    }
  });

  it("verifies an A-based squash before folding it into an unpromoted B compact chain", () => {
    const { repo, cleanup } = initRepo();
    try {
      const bootstrap = prepareBootstrap(repo);
      checkout(repo, "compile-a", bootstrap.historicalSource);
      const compactA = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: bootstrap.base,
        source: bootstrap.historicalSource,
        preparedPartition: {
          base: bootstrap.base,
          source: bootstrap.historicalSource,
          head: bootstrap.partition,
        },
      }).head;

      checkout(repo, "upstream-b", bootstrap.base);
      write(repo, "upstream-only.txt", "preserve B\n");
      const upstreamB = commit(repo, "upstream B");
      checkout(repo, "compact-b", compactA);
      const compactB = replayCarrySetOnto({
        repo,
        worktree: repo,
        sourceBase: bootstrap.base,
        compactHead: compactA,
        onto: upstreamB,
      }).head;

      const pr = makePartitionedSquash(repo, compactA, () => {
        write(repo, "action-next.txt", "new action behavior\n");
      });
      checkout(repo, "compile-b-revision", pr.squash);
      const revision = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: upstreamB,
        source: pr.squash,
        previousCompactHead: compactB,
        representedSource: compactA,
      });
      assert.equal(
        readCarryGroupChain(repo, revision.head, upstreamB).length,
        CARRY_REPLAY_GROUPS.length,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "upstream-only.txt"), "utf8"),
        "preserve B\n",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "action-next.txt"), "utf8"),
        "new action behavior\n",
      );
      const groups = readCarryGroupChain(repo, revision.head, upstreamB);
      assert.equal(
        groups.find(({ group }) => group === "resumable-actions")?.contributions.length,
        2,
      );
      assert.equal(groups.find(({ group }) => group === "legacy-sidebar")?.contributions.length, 2);
    } finally {
      cleanup();
    }
  });

  it("rejects a partition whose recorded base is not the squash parent", () => {
    const { repo, cleanup } = initRepo();
    try {
      const bootstrap = prepareBootstrap(repo);
      checkout(repo, "compile-a", bootstrap.historicalSource);
      const compact = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: bootstrap.base,
        source: bootstrap.historicalSource,
        preparedPartition: {
          base: bootstrap.base,
          source: bootstrap.historicalSource,
          head: bootstrap.partition,
        },
      }).head;
      const alternateBase = commitTree(
        repo,
        git(repo, ["rev-parse", `${compact}^{tree}`]),
        compact,
        "alternate merge base with the same tree",
      );
      checkout(repo, "wrong-base-source", alternateBase);
      write(repo, "wrong-base.txt", "partition delta\n");
      const sourceHead = commit(repo, "partition delta", "Carry-Group: tooling");
      const sourceRef = `refs/lastcode/carry-sources/pr-3/${sourceHead}`;
      git(repo, ["update-ref", sourceRef, sourceHead]);
      const squash = commitTree(
        repo,
        git(repo, ["rev-parse", `${sourceHead}^{tree}`]),
        compact,
        [
          "wrong-base squash (#3)",
          "",
          `Carry-Source-Ref: ${sourceRef}`,
          `Carry-Source-Base: ${alternateBase}`,
          `Carry-Source-Head: ${sourceHead}`,
        ].join("\n"),
      );
      assert.throws(
        () =>
          expandCarrySource({
            repo,
            base: bootstrap.base,
            source: squash,
            previousCompactHead: compact,
          }),
        /does not equal squash parent/u,
      );
    } finally {
      cleanup();
    }
  });

  it("historical rollback starts from the latest compact result and appends the current tail", () => {
    const { repo, cleanup } = initRepo();
    try {
      const bootstrap = prepareBootstrap(repo);
      checkout(repo, "compile-a", bootstrap.historicalSource);
      const compactA = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: bootstrap.base,
        source: bootstrap.historicalSource,
        preparedPartition: {
          base: bootstrap.base,
          source: bootstrap.historicalSource,
          head: bootstrap.partition,
        },
      }).head;
      checkout(repo, "upstream-b", bootstrap.base);
      write(repo, "resolved-on-b.txt", "semantic repair B\n");
      const upstreamB = commit(repo, "upstream B with resolution context");
      checkout(repo, "compact-b", compactA);
      const compactB = replayCarrySetOnto({
        repo,
        worktree: repo,
        sourceBase: bootstrap.base,
        compactHead: compactA,
        onto: upstreamB,
      }).head;

      const pr = makePartitionedSquash(repo, compactA, () => {
        write(repo, "after-compact.txt", "new PR while compact B is unpromoted\n");
      });
      const currentSource = pr.squash;
      checkout(repo, "upstream-c", upstreamB);
      write(repo, "upstream-c.txt", "from C\n");
      const upstreamC = commit(repo, "upstream C");
      checkout(repo, "historical-fallback", currentSource);
      const result = replayUngroupedOnto({
        repo,
        worktree: repo,
        sourceBase: upstreamB,
        currentSource,
        onto: upstreamC,
        representedCompactHead: compactB,
        representedSource: compactA,
      });
      assert.equal(result.phase, "historical");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "resolved-on-b.txt"), "utf8"),
        "semantic repair B\n",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(repo, "after-compact.txt"), "utf8"),
        "new PR while compact B is unpromoted\n",
      );
      assert.equal(NodeFS.readFileSync(NodePath.join(repo, "upstream-c.txt"), "utf8"), "from C\n");
      assert.equal(readCarryReplayPlan(repo)?.source, currentSource);
    } finally {
      cleanup();
    }
  });
});
