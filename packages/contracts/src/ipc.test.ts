import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopLocalBuildFailureSchema,
  DesktopUpdateReleaseNoteSchema,
} from "./ipc.ts";

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
        summaries: ["…and 2 more LastCode changes"],
      }),
    ).toEqual({
      version: "1.2.3-nightly.2",
      heading: "LastCode changes",
      items: ["feat(lastcode): local change"],
      summaries: ["…and 2 more LastCode changes"],
    });
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});
