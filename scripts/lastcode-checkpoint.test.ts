import { assert, it } from "@effect/vitest";

import {
  promotionNeeded,
  resolveCheckpointPlan,
  worktreeAddArgs,
  worktreeVp,
} from "./lastcode-checkpoint.ts";
import { parseNightlyTag } from "./lastcode-nightly.ts";

function nightly(tag: string) {
  const value = parseNightlyTag(tag);
  assert.ok(value);
  return value;
}

it("uses Git's supported short option when creating the recovery branch", () => {
  assert.deepStrictEqual(worktreeAddArgs("sync/nightly/v1", "/tmp/sync", "checkpoint"), [
    "worktree",
    "add",
    "-b",
    "sync/nightly/v1",
    "/tmp/sync",
    "checkpoint",
  ]);
});

it("runs smoke checks with the isolated worktree's Vite+ binary", () => {
  assert.equal(worktreeVp("/tmp/sync"), "/tmp/sync/node_modules/.bin/vp");
});

it("skips promotion when main already points at the checkpoint", () => {
  assert.equal(promotionNeeded("same", "same"), false);
  assert.equal(promotionNeeded("main", "checkpoint"), true);
});

it("bootstraps at the source nightly and checkpoints every later nightly", () => {
  const plan = resolveCheckpointPlan({
    checkpointRefs: [],
    nightlyTags: [
      "v0.0.2-nightly.20260103.3",
      "v0.0.1-nightly.20260101.1",
      "v0.0.1-nightly.20260102.2",
    ],
    sourceCommit: "source",
    sourceNightlyTags: ["v0.0.1-nightly.20260101.1"],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.bootstrapCheckpoint, true);
  assert.equal(plan.baseNightly.tag, "v0.0.1-nightly.20260101.1");
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.1-nightly.20260102.2", "v0.0.2-nightly.20260103.3"],
  );
});

it("continues from a newer unpromoted checkpoint when main has not changed", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const newer = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "main", nightly: old },
      { checkpointTag: `lastcode/checkpoint/${newer.tag}`, commit: "checkpoint", nightly: newer },
    ],
    nightlyTags: [old.tag, newer.tag, "v0.0.2-nightly.20260103.3"],
    sourceCommit: "main",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, `lastcode/checkpoint/${newer.tag}`);
  assert.equal(plan.baseNightly.tag, newer.tag);
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.2-nightly.20260103.3"],
  );
});

it("carries new main commits directly to the next missing nightly", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const checkpointed = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "old-main", nightly: old },
      {
        checkpointTag: `lastcode/checkpoint/${checkpointed.tag}`,
        commit: "checkpoint",
        nightly: checkpointed,
      },
    ],
    nightlyTags: [old.tag, checkpointed.tag, "v0.0.2-nightly.20260103.3"],
    sourceCommit: "main-with-new-feature",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, "origin/lastcode/main");
  assert.equal(plan.baseNightly.tag, old.tag);
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.2-nightly.20260103.3"],
  );
});
