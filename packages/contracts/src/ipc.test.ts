import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopLocalBuildFailureSchema, DesktopUpdateReleaseNoteSchema } from "./ipc.ts";

describe("DesktopLocalBuildFailureSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopLocalBuildFailureSchema);

  it("preserves the complete typed build diagnostic", () => {
    const failure = {
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.4",
      phase: "Building DMG",
      percent: 94,
      errorKind: "packaging",
      currentVersion: "1.2.2",
      targetVersion: "1.2.3-nightly.4",
      logPath: "/Users/test/.lastcode/local-updates/build.log",
      error: "hdiutil failed",
    };

    expect(decode(failure)).toEqual(failure);
    expect(() => decode({ ...failure, percent: 100 })).toThrow();
  });
});

describe("DesktopUpdateReleaseNoteSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopUpdateReleaseNoteSchema);

  it("preserves optional local headings and non-bulleted summaries", () => {
    expect(
      decode({
        version: "1.2.3-nightly.2",
        heading: "LastCode changes",
        items: ["feat(lastcode): local change"],
        totalItems: 3,
        summaries: ["…and 2 more LastCode changes"],
      }),
    ).toEqual({
      version: "1.2.3-nightly.2",
      heading: "LastCode changes",
      items: ["feat(lastcode): local change"],
      totalItems: 3,
      summaries: ["…and 2 more LastCode changes"],
    });
  });
});
