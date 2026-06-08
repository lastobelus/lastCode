import { assert, it } from "@effect/vitest";

import {
  compareNightlyTags,
  parseNightlyTag,
  resolveLatestNightlyTag,
  versionFromNightlyTag,
} from "./lastcode-nightly.ts";

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
