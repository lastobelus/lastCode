import { describe, expect, it } from "vite-plus/test";

import {
  immutableSourceFetchRefspec,
  installablePublicationArgs,
  parseManifestReplayConfiguration,
  resolveCheckpointReplay,
  sourceObjectRef,
} from "./lastcode-carry-checkpoint.ts";

describe("production carry checkpoint policy", () => {
  it("keeps pre-cutover manifests on historical replay", () => {
    expect(resolveCheckpointReplay({ configured: parseManifestReplayConfiguration({}) })).toEqual({
      mode: "historical",
      configuredMode: "legacy",
    });
  });

  it("requires the pinned bootstrap for carry mode", () => {
    expect(() => parseManifestReplayConfiguration({ replay: { mode: "carry" } })).toThrow(
      "requires replay.bootstrap",
    );
    expect(
      parseManifestReplayConfiguration({
        replay: {
          mode: "carry",
          bootstrap: { base: "base", source: "source", head: "head", ref: "frozen" },
        },
      }),
    ).toEqual({
      mode: "carry",
      bootstrap: { base: "base", source: "source", head: "head", ref: "frozen" },
    });
  });

  it("never silently falls back from configured carry replay", () => {
    const configured = parseManifestReplayConfiguration({
      replay: { mode: "carry", bootstrap: { base: "base", source: "source", head: "head" } },
    });
    expect(resolveCheckpointReplay({ configured }).mode).toBe("carry");
    expect(() => resolveCheckpointReplay({ configured, requestedMode: "historical" })).toThrow(
      "requires a nonempty --rollback-reason",
    );
    expect(
      resolveCheckpointReplay({
        configured,
        requestedMode: "historical",
        rollbackReason: "carry compiler regression",
      }),
    ).toMatchObject({
      mode: "historical",
      configuredMode: "carry",
      rollbackReason: "carry compiler regression",
    });
  });

  it("publishes and fetches immutable canonical source refs", () => {
    const tag = "lastcode/revision/v0.0.1-nightly.20260905.1.2";
    expect(sourceObjectRef(tag)).toBe("refs/lastcode/sources/v0.0.1-nightly.20260905.1.2");
    expect(immutableSourceFetchRefspec()).toBe("refs/lastcode/sources/*:refs/lastcode/sources/*");
    expect(
      installablePublicationArgs({
        remote: "origin",
        installableTag: tag,
        sourceCommit: "source-sha",
        noVerify: true,
      }),
    ).toEqual([
      "push",
      "--no-verify",
      "--atomic",
      "--force-with-lease=refs/lastcode/sources/v0.0.1-nightly.20260905.1.2:0000000000000000000000000000000000000000",
      "origin",
      tag,
      "source-sha:refs/lastcode/sources/v0.0.1-nightly.20260905.1.2",
    ]);
  });
});
