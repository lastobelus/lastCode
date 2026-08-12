import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  buildTagFromCheckpointTag,
  checkpointTagFromNightlyTag,
  cleanGitEnvironment,
  compareNightlyTags,
  nightlyTagFromCheckpointTag,
  parseNightlyTag,
  resolveLatestNightlyTag,
  resolveRepoRoot,
  resolveUncheckpointedNightlies,
  versionFromNightlyTag,
} from "./lastcode-nightly.ts";

it("removes repository-local Git variables without removing authentication", () => {
  assert.deepStrictEqual(
    cleanGitEnvironment({
      GIT_DIR: "/tmp/repo/.git",
      GIT_WORK_TREE: "/tmp/repo",
      GIT_INDEX_FILE: "/tmp/repo/.git/index",
      GIT_SSH_COMMAND: "ssh -i key",
      PATH: "/usr/bin",
      UNDEFINED_VALUE: undefined,
    }),
    {
      GIT_SSH_COMMAND: "ssh -i key",
      PATH: "/usr/bin",
    },
  );
});

it("parses upstream nightly tags", () => {
  assert.deepStrictEqual(parseNightlyTag("v0.0.25-nightly.20260606.480"), {
    tag: "v0.0.25-nightly.20260606.480",
    major: 0,
    minor: 0,
    patch: 25,
    date: 20260606,
    runNumber: 480,
  });
  assert.equal(parseNightlyTag("v0.0.25"), undefined);
});

it("sorts nightly tags by semver, date, and run number", () => {
  const older = parseNightlyTag("v0.0.25-nightly.20260605.999");
  const newer = parseNightlyTag("v0.0.25-nightly.20260606.1");
  assert.ok(older && newer);
  assert.ok(compareNightlyTags(newer, older) > 0);
});

it("resolves the latest nightly tag from mixed tags", () => {
  assert.equal(
    resolveLatestNightlyTag([
      "v0.0.25",
      "v0.0.25-nightly.20260605.479",
      "v0.0.25-nightly.20260606.480",
      "v0.0.24-nightly.20260607.999",
    ])?.tag,
    "v0.0.25-nightly.20260606.480",
  );
});

it("derives package versions from nightly tags", () => {
  assert.equal(
    versionFromNightlyTag("v0.0.25-nightly.20260606.480"),
    "0.0.25-nightly.20260606.480",
  );
});

it("maps immutable LastCode checkpoint and build tags", () => {
  const nightly = "v0.0.25-nightly.20260606.480";
  const checkpoint = `lastcode/checkpoint/${nightly}`;

  assert.equal(checkpointTagFromNightlyTag(nightly), checkpoint);
  assert.equal(nightlyTagFromCheckpointTag(checkpoint), nightly);
  assert.equal(
    buildTagFromCheckpointTag(checkpoint, 2),
    "lastcode/build/v0.0.25-nightly.20260606.480.2",
  );
  assert.equal(nightlyTagFromCheckpointTag("v0.0.25-nightly.20260606.480"), undefined);
});

it("lists every uncheckpointed nightly oldest first", () => {
  assert.deepStrictEqual(
    resolveUncheckpointedNightlies(
      [
        "v0.0.26-nightly.20260607.482",
        "not-a-nightly",
        "v0.0.25-nightly.20260606.480",
        "v0.0.26-nightly.20260607.481",
      ],
      ["lastcode/checkpoint/v0.0.26-nightly.20260607.481", "unrelated/tag"],
    ).map(({ tag }) => tag),
    ["v0.0.25-nightly.20260606.480", "v0.0.26-nightly.20260607.482"],
  );
});

it.effect("resolves the current linked worktree as the repository root", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = yield* resolveRepoRoot();
    const expectedRepoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    assert.equal(repoRoot, path.resolve(expectedRepoRoot));
  }).pipe(Effect.provide(NodeServices.layer)),
);
