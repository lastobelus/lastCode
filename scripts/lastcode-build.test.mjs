import { describe, expect, it } from "vite-plus/test";

import {
  parseBuildResult,
  parseOptions,
  renderLauncher,
  resolveCheckpointTag,
} from "./lastcode-build.mjs";

const tags = [
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1092",
  "lastcode/checkpoint/v0.0.34-nightly.20260814.1095",
];

describe("LastCode userland build command", () => {
  it("accepts positional and named checkpoint selectors", () => {
    expect(parseOptions(["1090"]).checkpoint).toBe("1090");
    expect(parseOptions(["--checkpoint", "1092"]).checkpoint).toBe("1092");
    expect(parseOptions(["-c", "1095"]).checkpoint).toBe("1095");
    expect(() => parseOptions(["1090", "1092"])).toThrow("Unexpected second checkpoint");
  });

  it("selects the newest checkpoint by default", () => {
    expect(resolveCheckpointTag(tags)).toBe("lastcode/checkpoint/v0.0.34-nightly.20260814.1095");
  });

  it("resolves checkpoint number shorthand and full tags", () => {
    expect(resolveCheckpointTag(tags, "1090")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
    );
    expect(resolveCheckpointTag(tags, "v0.0.34-nightly.20260814.1092")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1092",
    );
    expect(resolveCheckpointTag(tags, "lastcode/checkpoint/v0.0.34-nightly.20260814.1095")).toBe(
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1095",
    );
  });

  it("rejects missing and ambiguous shorthand", () => {
    expect(() => resolveCheckpointTag(tags, "1000")).toThrow("was not found");
    expect(() =>
      resolveCheckpointTag(
        [
          "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
          "lastcode/checkpoint/v0.0.35-nightly.20260815.1090",
        ],
        "1090",
      ),
    ).toThrow("ambiguous");
  });

  it("parses the existing local update helper result", () => {
    expect(
      parseBuildResult(
        'noise\nLASTCODE_LOCAL_UPDATE_RESULT={"schemaVersion":1,"status":"built","outputDir":"/tmp/build"}\n',
      ),
    ).toMatchObject({ status: "built", outputDir: "/tmp/build" });
  });

  it("launches with the repository's pinned Node runtime", () => {
    expect(renderLauncher("/tmp/Last Code/lastcode-build.mjs")).toContain(
      "mise exec node@24.13.1 -- node '/tmp/Last Code/lastcode-build.mjs' \"$@\"",
    );
  });
});
