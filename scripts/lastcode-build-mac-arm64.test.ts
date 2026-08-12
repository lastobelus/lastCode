import { expect, it } from "vite-plus/test";

import { parseBuildOptions, resolveNextBuildNumber } from "./lastcode-build-mac-arm64.ts";

const checkpoint = "lastcode/checkpoint/v1.2.3-nightly.20260811.9";

it("requires an explicit immutable checkpoint", () => {
  expect(() => parseBuildOptions([])).toThrow("A checkpoint is required");
  expect(parseBuildOptions(["--checkpoint", checkpoint, "--push-tag"])).toEqual({
    checkpointTag: checkpoint,
    outputRoot: "release-lastcode",
    pushTag: true,
    verbose: false,
  });
});

it("allocates monotonically increasing build tags per checkpoint", () => {
  expect(
    resolveNextBuildNumber(checkpoint, [
      "lastcode/build/v1.2.3-nightly.20260811.9.1",
      "lastcode/build/v1.2.3-nightly.20260811.9.3",
      "lastcode/build/v1.2.3-nightly.20260810.8.99",
    ]),
  ).toBe(4);
});
