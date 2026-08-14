import { expect, it } from "vite-plus/test";

import {
  parseBuildOptions,
  resolveBuildEnvironment,
  resolveNextBuildNumber,
} from "./lastcode-build-mac-arm64.ts";

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

it("forces updater metadata generation for local LastCode builds", () => {
  expect(resolveBuildEnvironment("/opt/rust/bin/cargo", { PATH: "/usr/bin" })).toMatchObject({
    PATH: "/opt/rust/bin:/usr/bin",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "lastobelus/lastCode",
  });
  expect(
    resolveBuildEnvironment("/opt/rust/bin/cargo", {
      LASTCODE_GITHUB_REPOSITORY: "example/fork",
    }).T3CODE_DESKTOP_UPDATE_REPOSITORY,
  ).toBe("example/fork");
});
