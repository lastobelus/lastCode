// @effect-diagnostics nodeBuiltinImport:off -- This test builds a disposable Git repository.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  attributeCarryPaths,
  CARRY_GROUPS,
  carrySetShadowTarget,
  parseCarryCommit,
  planCarrySet,
  pullRequestFromSubject,
  runCarrySetShadowCheck,
  type CarrySetManifest,
} from "./lastcode-carry-set.ts";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const manifest: CarrySetManifest = {
  schemaVersion: 1,
  order: CARRY_GROUPS,
  groups: {
    "upstream-bugfixes": {
      pullRequests: [10],
      upstreamPullRequests: { "10": ["https://github.com/upstream/repo/pull/20"] },
    },
    tooling: { subjects: ["bootstrap tooling"] },
    "resumable-actions": { pullRequests: [30] },
    "legacy-sidebar": { pullRequests: [40] },
    incubator: { default: true },
  },
};

it("extracts a LastCode PR number only from a trailing squash suffix", () => {
  assert.equal(pullRequestFromSubject("fix(web): example (#123)"), 123);
  assert.equal(pullRequestFromSubject("mention #123 without a squash suffix"), undefined);
});

it("parses commit records without making rebased SHAs part of the grouping key", () => {
  assert.deepStrictEqual(parseCarryCommit("abc123\tfix(web): example (#123)"), {
    commit: "abc123",
    subject: "fix(web): example (#123)",
    pullRequest: 123,
  });
});

it("selects carry-set base and source from immutable tag metadata", () => {
  assert.deepStrictEqual(
    carrySetShadowTarget(
      "lastcode/checkpoint/v1-nightly.1",
      "LastCode checkpoint\n\nUpstream-Commit: upstream-sha\nLastCode-Commit: lastcode-sha\n",
      "lastcode-sha",
    ),
    {
      checkpointTag: "lastcode/checkpoint/v1-nightly.1",
      baseCommit: "upstream-sha",
      sourceCommit: "lastcode-sha",
    },
  );
  assert.throws(
    () =>
      carrySetShadowTarget(
        "lastcode/checkpoint/v1-nightly.1",
        "Upstream-Commit: upstream-sha\nLastCode-Commit: other-sha\n",
        "lastcode-sha",
      ),
    /tag resolves to/,
  );
});

it("groups known PRs and subjects in fixed order and sends unknown work to Incubator", () => {
  const plan = planCarrySet(
    [
      parseCarryCommit("a\tfeat: sidebar (#40)"),
      parseCarryCommit("b\tbootstrap tooling"),
      parseCarryCommit("c\tfix: upstream (#10)"),
      parseCarryCommit("d\tfeat: not classified (#99)"),
      parseCarryCommit("e\tfeat: resume (#30)"),
    ],
    manifest,
  );

  assert.deepStrictEqual(
    plan.map(({ id, commits }) => ({ id, commits: commits.map(({ commit }) => commit) })),
    [
      { id: "upstream-bugfixes", commits: ["c"] },
      { id: "tooling", commits: ["b"] },
      { id: "resumable-actions", commits: ["e"] },
      { id: "legacy-sidebar", commits: ["a"] },
      { id: "incubator", commits: ["d"] },
    ],
  );
});

it("requires upstream PR provenance for every upstream bugfix assignment", () => {
  assert.throws(
    () =>
      planCarrySet([], {
        ...manifest,
        groups: {
          ...manifest.groups,
          "upstream-bugfixes": { pullRequests: [10] },
        },
      }),
    /no upstream PR provenance/,
  );
});

it("keeps exclusive files with their group and sends shared files to Incubator", () => {
  assert.deepStrictEqual(
    attributeCarryPaths(
      ["upstream.ts", "tool.ts", "shared.ts", "unattributed.ts"],
      [
        { group: "upstream-bugfixes", paths: ["upstream.ts", "shared.ts"] },
        { group: "tooling", paths: ["tool.ts", "shared.ts"] },
      ],
    ),
    {
      "upstream-bugfixes": ["upstream.ts"],
      tooling: ["tool.ts"],
      "resumable-actions": [],
      "legacy-sidebar": [],
      incubator: ["shared.ts", "unattributed.ts"],
    },
  );
});

it("reconstructs renames without retaining the source path", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-set-test-"));
  try {
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.name", "Carry set test"]);
    git(repo, ["config", "user.email", "carry-set-test@localhost"]);
    NodeFS.writeFileSync(NodePath.join(repo, "before.ts"), "export const value = 1;\n");
    git(repo, ["add", "before.ts"]);
    git(repo, ["commit", "--quiet", "-m", "upstream base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);

    git(repo, ["mv", "before.ts", "after.ts"]);
    git(repo, ["commit", "--quiet", "-m", "rename downstream file"]);
    const source = git(repo, ["rev-parse", "HEAD"]);
    const tag = "lastcode/checkpoint/test-rename";
    git(repo, [
      "tag",
      "--annotate",
      tag,
      source,
      "--message",
      `Carry set rename test\n\nUpstream-Commit: ${base}\nLastCode-Commit: ${source}`,
    ]);

    const result = runCarrySetShadowCheck(repo, tag);
    assert.equal(result.tree, git(repo, ["rev-parse", `${source}^{tree}`]));
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});
