import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  announceLocalPackageReady,
  parseBuildOptions,
  resolveBuildEnvironment,
  resolveNextBuildNumber,
} from "./lastcode-build-mac.ts";

const checkpoint = "lastcode/checkpoint/v1.2.3-nightly.20260811.9";

it.effect("writes the package readiness marker to the selected artifact root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const commit = "a".repeat(40);
    yield* Effect.sync(() => announceLocalPackageReady(root, commit));
    expect(yield* fs.readFileString(path.join(root, "package-ready"))).toBe(`${commit}\n`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

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
    LASTCODE_PUBLIC_CONNECT_DEFAULTS: "1",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "lastobelus/lastCode",
  });
  expect(
    resolveBuildEnvironment("/opt/rust/bin/cargo", {
      LASTCODE_GITHUB_REPOSITORY: "example/fork",
    }).T3CODE_DESKTOP_UPDATE_REPOSITORY,
  ).toBe("example/fork");
});

it("preserves an explicit opt-out of production Connect defaults", () => {
  expect(
    resolveBuildEnvironment("/opt/rust/bin/cargo", {
      LASTCODE_PUBLIC_CONNECT_DEFAULTS: "0",
    }).LASTCODE_PUBLIC_CONNECT_DEFAULTS,
  ).toBe("0");
});
