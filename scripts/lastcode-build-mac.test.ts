import { expect, it } from "vite-plus/test";

import {
  parseBuildOptions,
  resolveBuildEnvironment,
  resolveNextBuildNumber,
} from "./lastcode-build-mac.ts";

const checkpoint = "lastcode/checkpoint/v1.2.3-nightly.20260811.9";

it("requires an explicit immutable installable tag", () => {
  expect(() => parseBuildOptions([])).toThrow("An installable tag is required");
  expect(() => parseBuildOptions(["--checkpoint", checkpoint])).toThrow(
    "A target architecture is required",
  );
  expect(parseBuildOptions(["--arch", "x64", "--checkpoint", checkpoint, "--push-tag"])).toEqual({
    arch: "x64",
    checkpointTag: checkpoint,
    outputRoot: "release-lastcode",
    pushTag: true,
    verbose: false,
  });
  expect(() => parseBuildOptions(["--arch", "universal", "--checkpoint", checkpoint])).toThrow(
    "Unsupported macOS architecture",
  );
});

it("allocates monotonically increasing build tags per checkpoint", () => {
  expect(
    resolveNextBuildNumber(checkpoint, [
      "lastcode/build/v1.2.3-nightly.20260811.9.1",
      "lastcode/build/v1.2.3-nightly.20260811.9.3",
      "lastcode/build/v1.2.3-nightly.20260810.8.99",
    ]),
  ).toBe(4);
  expect(
    resolveNextBuildNumber("lastcode/revision/v1.2.3-nightly.20260811.9.2", [
      "lastcode/build/v1.2.3-nightly.20260811.9.2.1",
      "lastcode/build/v1.2.3-nightly.20260811.9.2.2",
    ]),
  ).toBe(3);
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
