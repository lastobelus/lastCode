import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  buildTagFromInstallableTag,
  checkpointTagFromNightlyTag,
  cleanGitEnvironment,
  compareLastCodeInstallableTags,
  compareNightlyTags,
  nightlyTagFromCheckpointTag,
  parseLastCodeInstallableTag,
  parseNightlyTag,
  revisionTagFromNightlyTag,
  resolveLatestNightlyTag,
  resolveRepoRoot,
  resolveUncheckpointedNightlies,
  versionFromLastCodeInstallableTag,
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

it("preserves nightly numeric conversions and the original tag", () => {
  const tag = "v001.002.003-nightly.00000000.004";
  assert.deepStrictEqual(parseNightlyTag(tag), {
    tag,
    major: 1,
    minor: 2,
    patch: 3,
    date: 0,
    runNumber: 4,
  });
  assert.deepStrictEqual(parseNightlyTag("v0.0.0-nightly.99999999.0"), {
    tag: "v0.0.0-nightly.99999999.0",
    major: 0,
    minor: 0,
    patch: 0,
    date: 99999999,
    runNumber: 0,
  });
  const long = "9007199254740993";
  const overflow = "9".repeat(400);
  assert.deepStrictEqual(
    parseNightlyTag(`v${long}.${overflow}.${long}-nightly.12345678.${overflow}`),
    {
      tag: `v${long}.${overflow}.${long}-nightly.12345678.${overflow}`,
      major: 9007199254740992,
      minor: Infinity,
      patch: 9007199254740992,
      date: 12345678,
      runNumber: Infinity,
    },
  );
});

it("rejects malformed nightly fields and native regex newline boundaries", () => {
  const nightly = "v1.2.3-nightly.12345678.4";
  const invalid = [
    "V1.2.3-nightly.12345678.4",
    "1.2.3-nightly.12345678.4",
    "v1_2.3-nightly.12345678.4",
    "v1.2.3-Nightly.12345678.4",
    "v.2.3-nightly.12345678.4",
    "v1..3-nightly.12345678.4",
    "v1.2.-nightly.12345678.4",
    "v1.2.3-nightly..4",
    "v1.2.3-nightly.1234567.4",
    "v1.2.3-nightly.123456789.4",
    "v1.2.3-nightly.12345678.",
    "v１.2.3-nightly.12345678.4",
    "v1.٢.3-nightly.12345678.4",
    "v1.2.３-nightly.12345678.4",
    "v1.2.3-nightly.１２３４５６７８.4",
    "v1.2.3-nightly.12345678.٤",
    `${nightly}.1`,
    ` ${nightly}`,
    `\n${nightly}`,
    nightly.replace("-nightly", "\n-nightly"),
    ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((suffix) => nightly + suffix),
  ];
  for (const tag of invalid) assert.equal(parseNightlyTag(tag), undefined, tag);
});

it("preserves checkpoint and revision helper validation for unusual nightly numbers", () => {
  const nightly = "v001.0.0-nightly.00000000.0";
  const checkpoint = `lastcode/checkpoint/${nightly}`;
  const revision = `lastcode/revision/${nightly}.01`;
  assert.equal(checkpointTagFromNightlyTag(nightly), checkpoint);
  assert.equal(nightlyTagFromCheckpointTag(checkpoint), nightly);
  assert.equal(revisionTagFromNightlyTag(nightly, 1), `lastcode/revision/${nightly}.1`);
  assert.equal(parseLastCodeInstallableTag(checkpoint)?.revision, 0);
  assert.equal(parseLastCodeInstallableTag(revision)?.revision, 1);
  assert.equal(versionFromNightlyTag(nightly), "001.0.0-nightly.00000000.0");
  assert.equal(versionFromLastCodeInstallableTag(revision), "001.0.0-nightly.00000000.0.1");
  for (const suffix of ["0", "9007199254740993", "9".repeat(400), "1\n"]) {
    const invalid = `lastcode/revision/${nightly}.${suffix}`;
    assert.equal(parseLastCodeInstallableTag(invalid), undefined);
    assert.throws(
      () => versionFromLastCodeInstallableTag(invalid),
      Error,
      `Invalid LastCode installable tag '${invalid}'.`,
    );
  }
  assert.throws(() => checkpointTagFromNightlyTag(nightly + "\n"));
  assert.throws(() => revisionTagFromNightlyTag(nightly, 0));
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

it("maps immutable LastCode checkpoint, revision, and build tags", () => {
  const nightly = "v0.0.25-nightly.20260606.480";
  const checkpoint = `lastcode/checkpoint/${nightly}`;
  const revision = `lastcode/revision/${nightly}.2`;

  assert.equal(checkpointTagFromNightlyTag(nightly), checkpoint);
  assert.equal(nightlyTagFromCheckpointTag(checkpoint), nightly);
  assert.equal(revisionTagFromNightlyTag(nightly, 2), revision);
  assert.deepStrictEqual(parseLastCodeInstallableTag(revision), {
    tag: revision,
    nightly: parseNightlyTag(nightly),
    revision: 2,
  });
  assert.equal(versionFromLastCodeInstallableTag(checkpoint), "0.0.25-nightly.20260606.480");
  assert.equal(versionFromLastCodeInstallableTag(revision), "0.0.25-nightly.20260606.480.2");
  assert.equal(
    buildTagFromInstallableTag(checkpoint, 2),
    "lastcode/build/v0.0.25-nightly.20260606.480.2",
  );
  assert.equal(
    buildTagFromInstallableTag(revision, 3),
    "lastcode/build/v0.0.25-nightly.20260606.480.2.3",
  );
  assert.equal(nightlyTagFromCheckpointTag("v0.0.25-nightly.20260606.480"), undefined);
});

it("orders LastCode revisions after their checkpoint and before the next nightly", () => {
  const checkpoint = parseLastCodeInstallableTag(
    "lastcode/checkpoint/v0.0.25-nightly.20260606.480",
  );
  const revision = parseLastCodeInstallableTag("lastcode/revision/v0.0.25-nightly.20260606.480.1");
  const nextNightly = parseLastCodeInstallableTag(
    "lastcode/checkpoint/v0.0.25-nightly.20260606.481",
  );
  assert.ok(checkpoint && revision && nextNightly);
  assert.ok(compareLastCodeInstallableTags(revision, checkpoint) > 0);
  assert.ok(compareLastCodeInstallableTags(nextNightly, revision) > 0);
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
