import { assert, it } from "@effect/vitest";

import {
  attributeCarryPaths,
  CARRY_GROUPS,
  parseCarryCommit,
  planCarrySet,
  pullRequestFromSubject,
  type CarrySetManifest,
} from "./lastcode-carry-set.ts";

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
