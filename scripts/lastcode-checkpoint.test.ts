import { assert, expect, it } from "@effect/vitest";

import {
  checkpointFailureDisposition,
  checkpointMessage,
  checkpointSourceCommit,
  checkpointTagPushArgs,
  checkpointVpPaths,
  promotionNeeded,
  resolveCheckpointPlan,
  unpublishedCheckpointTags,
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

it("bootstraps dependencies with the invoking worktree runner before using the isolated runner", () => {
  assert.deepStrictEqual(checkpointVpPaths("/tmp/automation", "/tmp/sync"), {
    bootstrap: "/tmp/automation/node_modules/.bin/vp",
    isolated: "/tmp/sync/node_modules/.bin/vp",
  });
});

it("publishes smoke-validated checkpoint tags without rerunning the generic pre-push gate", () => {
  assert.deepStrictEqual(
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "smoke",
    }),
    ["push", "--no-verify", "origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8"],
  );
});

it("retains the generic pre-push gate when it will validate the checkpoint commit", () => {
  assert.deepStrictEqual(
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "pre-push",
      candidateCommit: "checkpoint",
      checkoutHead: "checkpoint",
    }),
    ["push", "origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8"],
  );
});

it("refuses fallback publication when the pre-push hook would validate another commit", () => {
  expect(() =>
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "pre-push",
      candidateCommit: "checkpoint",
      checkoutHead: "invoking-worktree",
    }),
  ).toThrow(/would validate invoking-worktree, not checkpoint commit checkpoint/);
});

it("records dashboard metadata in annotated checkpoint tags", () => {
  const message = checkpointMessage({
    upstreamTag: "v1.2.3-nightly.20260812.8",
    upstreamCommit: "upstream-sha",
    commit: "lastcode-sha",
    sourceRef: "origin/lastcode/main",
    sourceCommit: "source-sha",
    timing: {
      commitsRebased: 8,
      startedAt: "2026-08-12T18:00:00.000Z",
      finishedAt: "2026-08-12T18:03:08.000Z",
      durationMs: 188_000,
    },
  });

  expect(message).toContain("Source-Commit: source-sha");
  expect(message).toContain(
    "Fork-Commits-Rebased: 8\nStarted-At: 2026-08-12T18:00:00.000Z\nFinished-At: 2026-08-12T18:03:08.000Z\nDuration-Ms: 188000",
  );
});

it("reads the source commit from checkpoint metadata", () => {
  assert.equal(
    checkpointSourceCommit("LastCode checkpoint\n\nSource-Commit: abc123\nDuration-Ms: 10"),
    "abc123",
  );
  assert.equal(checkpointSourceCommit("LastCode checkpoint without source metadata"), undefined);
});

it("skips promotion when main already points at the checkpoint", () => {
  assert.equal(promotionNeeded("same", "same"), false);
  assert.equal(promotionNeeded("main", "checkpoint"), true);
});

it("cleans up publication failures but retains recovery state for earlier failures", () => {
  assert.deepStrictEqual(
    checkpointFailureDisposition("lastcode/checkpoint/v1", "sync/nightly/v1"),
    { cleanup: true },
  );
  assert.deepStrictEqual(checkpointFailureDisposition(undefined, "sync/nightly/v1"), {
    cleanup: false,
    recoveryBranch: "sync/nightly/v1",
  });
  assert.deepStrictEqual(
    checkpointFailureDisposition("lastcode/checkpoint/v1", "sync/nightly/v1", false),
    { cleanup: false, recoveryBranch: "sync/nightly/v1" },
  );
});

it("retries checkpoint tags that are local but not published", () => {
  assert.deepStrictEqual(
    unpublishedCheckpointTags(
      ["lastcode/checkpoint/v1", "lastcode/checkpoint/v2"],
      "abc\trefs/tags/lastcode/checkpoint/v1\ndef\trefs/tags/lastcode/checkpoint/v1^{}\n",
    ),
    ["lastcode/checkpoint/v2"],
  );
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

it("retries promotion of a published checkpoint created from the current main", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const newer = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "old-main", nightly: old },
      {
        checkpointTag: `lastcode/checkpoint/${newer.tag}`,
        commit: "checkpoint",
        nightly: newer,
        sourceCommit: "main-with-feature",
      },
    ],
    nightlyTags: [old.tag, newer.tag],
    sourceCommit: "main-with-feature",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, `lastcode/checkpoint/${newer.tag}`);
  assert.equal(plan.baseNightly.tag, newer.tag);
  assert.deepStrictEqual(plan.missingNightlies, []);
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
