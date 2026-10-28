// @effect-diagnostics nodeBuiltinImport:off -- These tests build disposable Git repositories.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CARRY_REPLAY_GROUPS,
  completeCarryReplay,
  readCarryReplayPlan,
  type CarryReplayPlan,
} from "./lastcode-carry-replay.ts";
import { assertRecoverySelection, continueCarryRecovery } from "./lastcode-checkpoint.ts";
import { normalizeCheckpointCommits } from "./lastcode-quiet-references.ts";

const repositories: Array<string> = [];

function git(cwd: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function repository(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-quiet-recovery-"));
  repositories.push(root);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Quiet recovery test"]);
  git(root, ["config", "user.email", "quiet-recovery@example.invalid"]);
  return root;
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", subject, ...(body ? ["-m", body] : [])]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function carryFixture(): { readonly repo: string; readonly base: string; readonly head: string } {
  const repo = repository();
  NodeFS.writeFileSync(NodePath.join(repo, "fixture.txt"), "base\n");
  const base = commit(repo, "upstream base");
  for (const [index, group] of CARRY_REPLAY_GROUPS.entries()) {
    NodeFS.writeFileSync(NodePath.join(repo, "fixture.txt"), `group ${index}\n`);
    commit(
      repo,
      `carry(${group}): fixture group`,
      [
        `Carry-Group: ${group}`,
        `Carry-Fix: ${group} fixture`,
        ...(index === 0 ? ["Carry-Upstream: https://github.com/example/upstream/pull/42"] : []),
      ].join("\n"),
    );
  }
  return { repo, base, head: git(repo, ["rev-parse", "HEAD"]) };
}

function planPath(repo: string): string {
  return NodePath.join(
    git(repo, ["rev-parse", "--absolute-git-dir"]),
    "lastcode-carry-replay-plan.json",
  );
}

function writePlan(repo: string, plan: CarryReplayPlan): void {
  NodeFS.writeFileSync(planPath(repo), `${JSON.stringify(plan, undefined, 2)}\n`, { mode: 0o600 });
}

function replayPlan(
  phase: CarryReplayPlan["phase"],
  base: string,
  source: string,
  status: CarryReplayPlan["status"],
  resultHead?: string,
): CarryReplayPlan {
  return {
    schemaVersion: 1,
    status,
    phase,
    source,
    sourceBase: base,
    onto: base,
    ...(resultHead === undefined ? {} : { resultHead }),
  };
}

function replaceHeadWithCommit(
  repo: string,
  oldHead: string,
  tree: string,
  message: string,
): string {
  const parent = git(repo, ["rev-parse", `${oldHead}^`]);
  const replacement = git(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], message);
  git(repo, ["update-ref", "HEAD", replacement, oldHead]);
  return replacement;
}

afterEach(() => {
  for (const repo of repositories.splice(0)) NodeFS.rmSync(repo, { recursive: true, force: true });
});

describe("quiet checkpoint recovery", () => {
  it.each(["running", "complete"] as const)(
    "resumes a %s compile-phase rewrite before replaying onto a newer nightly",
    (status) => {
      const { repo, base, head: originalHead } = carryFixture();
      const nightlyTag = "v9.9.9-nightly.20990102.2";
      git(repo, ["checkout", "--quiet", "--detach", base]);
      NodeFS.writeFileSync(NodePath.join(repo, "upstream-new.txt"), "new upstream behavior\n");
      const nightlyHead = commit(repo, "new upstream nightly");
      git(repo, ["tag", nightlyTag, nightlyHead]);
      git(repo, ["checkout", "--quiet", "-b", `sync/nightly/${nightlyTag}`, originalHead]);
      writePlan(
        repo,
        replayPlan(
          "compile",
          base,
          originalHead,
          status,
          status === "complete" ? originalHead : undefined,
        ),
      );
      // The compilation head moves before its plan or recovery selection is updated.
      const normalizedHead = normalizeCheckpointCommits(repo, base);
      expect(normalizedHead).not.toBe(originalHead);
      const selection = { head: originalHead, sourceCommit: originalHead, nightlyTag };
      expect(() => assertRecoverySelection(repo, selection, originalHead, false)).not.toThrow();
      expect(() => assertRecoverySelection(repo, selection, originalHead)).toThrow(
        "Recovery does not contain the selected upstream nightly.",
      );

      const recoveredHead = continueCarryRecovery({
        repoRoot: repo,
        worktree: repo,
        selectedHead: originalHead,
        nightlyTag,
      });
      expect(git(repo, ["merge-base", nightlyHead, recoveredHead])).toBe(nightlyHead);
      expect(NodeFS.readFileSync(NodePath.join(repo, "upstream-new.txt"), "utf8")).toBe(
        "new upstream behavior\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(repo, "fixture.txt"), "utf8")).toBe("group 5\n");
      expect(git(repo, ["log", "--format=%B", `${nightlyHead}..${recoveredHead}`])).toContain(
        "https://redirect.github.com/example/upstream/pull/42",
      );
      expect(readCarryReplayPlan(repo)).toMatchObject({
        phase: "replay",
        status: "complete",
        onto: nightlyHead,
        resultHead: recoveredHead,
      });
      expect(() =>
        assertRecoverySelection(repo, { ...selection, head: recoveredHead }, originalHead),
      ).not.toThrow();
    },
  );

  it("rejects an unrelated compile-phase message amend before selection or continuation", () => {
    const { repo, base, head: originalHead } = carryFixture();
    const nightlyTag = "v9.9.9-nightly.20990101.1";
    git(repo, ["tag", nightlyTag, base]);
    git(repo, ["checkout", "--quiet", "-b", `sync/nightly/${nightlyTag}`, originalHead]);
    writePlan(repo, replayPlan("compile", base, originalHead, "complete", originalHead));
    const alteredHead = replaceHeadWithCommit(
      repo,
      originalHead,
      git(repo, ["rev-parse", `${originalHead}^{tree}`]),
      `${git(repo, ["show", "-s", "--format=%B", originalHead])}\nUnexpected amend\n`,
    );
    const selection = { head: originalHead, sourceCommit: originalHead, nightlyTag };

    expect(() => assertRecoverySelection(repo, selection, originalHead, false)).toThrow(
      "Retained recovery head or branch changed; select again.",
    );
    expect(() =>
      continueCarryRecovery({
        repoRoot: repo,
        worktree: repo,
        selectedHead: originalHead,
        nightlyTag,
      }),
    ).toThrow("Retained carry recovery head changed; inspect and select its exact head.");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(alteredHead);
  });

  it("reconciles a completed replay after normalization moved HEAD during a crash", () => {
    const { repo, base, head: originalHead } = carryFixture();
    const sourceRef = "refs/fixture/source";
    git(repo, ["update-ref", sourceRef, originalHead]);
    git(repo, ["tag", "fixture-source", originalHead]);
    writePlan(repo, replayPlan("replay", base, originalHead, "complete", originalHead));

    const normalizedHead = normalizeCheckpointCommits(repo, base);
    expect(normalizedHead).not.toBe(originalHead);
    expect(git(repo, ["rev-parse", sourceRef])).toBe(originalHead);
    expect(git(repo, ["rev-parse", "fixture-source"])).toBe(originalHead);

    const recovered = completeCarryReplay(repo);
    expect(recovered.head).toBe(normalizedHead);
    expect(readCarryReplayPlan(repo)).toMatchObject({
      status: "complete",
      resultHead: normalizedHead,
    });
    expect(completeCarryReplay(repo).head).toBe(normalizedHead);
  });

  it("rejects an unexpected same-tree message amend and code change", () => {
    for (const kind of ["message", "code"] as const) {
      const { repo, base, head: originalHead } = carryFixture();
      try {
        writePlan(repo, replayPlan("replay", base, originalHead, "complete", originalHead));
        const tree =
          kind === "message"
            ? git(repo, ["rev-parse", `${originalHead}^{tree}`])
            : (() => {
                NodeFS.writeFileSync(NodePath.join(repo, "fixture.txt"), "unexpected code\n");
                git(repo, ["add", "fixture.txt"]);
                const changedTree = git(repo, ["write-tree"]);
                git(repo, ["reset", "--quiet", "--hard", originalHead]);
                return changedTree;
              })();
        const message =
          kind === "message"
            ? `${git(repo, ["show", "-s", "--format=%B", originalHead])}\nUnexpected amend\n`
            : git(repo, ["show", "-s", "--format=%B", originalHead]);
        const alteredHead = replaceHeadWithCommit(repo, originalHead, tree, message);
        expect(alteredHead).not.toBe(originalHead);
        expect(() => completeCarryReplay(repo)).toThrow();
        expect(git(repo, ["rev-parse", "HEAD"])).toBe(alteredHead);
      } finally {
        NodeFS.rmSync(repo, { recursive: true, force: true });
        repositories.splice(repositories.indexOf(repo), 1);
      }
    }
  });

  it("finishes a running historical plan after its candidate was normalized", () => {
    const { repo, base, head: originalHead } = carryFixture();
    writePlan(repo, replayPlan("historical", base, originalHead, "running"));
    const normalizedHead = normalizeCheckpointCommits(repo, base);

    const completed = completeCarryReplay(repo);
    expect(completed.phase).toBe("historical");
    expect(completed.head).toBe(normalizedHead);
    expect(readCarryReplayPlan(repo)).toMatchObject({
      status: "complete",
      resultHead: normalizedHead,
    });
  });
});
