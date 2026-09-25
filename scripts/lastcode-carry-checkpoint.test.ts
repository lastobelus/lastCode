import { describe, expect, it } from "vite-plus/test";

import {
  immutableSourceFetchRefspec,
  installablePublicationArgs,
  parseManifestReplayConfiguration,
  resolveCheckpointReplay,
  sourceObjectRef,
} from "./lastcode-carry-checkpoint.ts";

describe("production carry checkpoint policy", () => {
  const base = "a".repeat(40);
  const source = "b".repeat(40);
  const head = "c".repeat(40);
  const representedSource = "d".repeat(40);

  it("keeps pre-cutover manifests on historical replay", () => {
    expect(resolveCheckpointReplay({ configured: parseManifestReplayConfiguration({}) })).toEqual({
      mode: "historical",
      configuredMode: "legacy",
    });
  });

  it("requires complete immutable proof for a cross-base historical bootstrap", () => {
    const sourceTag = "lastcode/checkpoint/v9.9.9-nightly.20990102.2";
    expect(
      parseManifestReplayConfiguration({
        replay: {
          mode: "carry",
          bootstrap: { base, source, head, representedSource, sourceTag },
        },
      }),
    ).toEqual({
      mode: "carry",
      bootstrap: { base, source, head, representedSource, sourceTag },
    });
    expect(() =>
      parseManifestReplayConfiguration({
        replay: { mode: "carry", bootstrap: { base, source, head, representedSource } },
      }),
    ).toThrow("representedSource and sourceTag must be configured together");
    expect(() =>
      parseManifestReplayConfiguration({
        replay: { mode: "carry", bootstrap: { base, source, head, sourceTag } },
      }),
    ).toThrow("representedSource and sourceTag must be configured together");
    expect(() =>
      parseManifestReplayConfiguration({
        replay: {
          mode: "carry",
          bootstrap: { base, source, head, representedSource, sourceTag: "main" },
        },
      }),
    ).toThrow("must name an immutable LastCode installable tag");
  });

  it("requires the pinned bootstrap for carry mode", () => {
    expect(() => parseManifestReplayConfiguration({ replay: { mode: "carry" } })).toThrow(
      "requires replay.bootstrap",
    );
    expect(
      parseManifestReplayConfiguration({
        replay: {
          mode: "carry",
          bootstrap: { base, source, head, ref: "frozen" },
        },
      }),
    ).toEqual({
      mode: "carry",
      bootstrap: { base, source, head, ref: "frozen" },
    });
    for (const field of ["base", "source", "head"] as const) {
      expect(() =>
        parseManifestReplayConfiguration({
          replay: {
            mode: "carry",
            bootstrap: { base, source, head, [field]: field === "base" ? "main" : "HEAD" },
          },
        }),
      ).toThrow(`replay.bootstrap.${field} to be an exact 40-character commit`);
    }
  });

  it("does not encode historical rollback as a manifest default", () => {
    expect(() => parseManifestReplayConfiguration({ replay: { mode: "historical" } })).toThrow(
      "manifest mode must be 'carry'",
    );
  });

  it("does not activate carry replay from the command line", () => {
    expect(() =>
      resolveCheckpointReplay({ configured: undefined, requestedMode: "carry" }),
    ).toThrow("requires an activated carry replay manifest");
  });

  it("never silently falls back from configured carry replay", () => {
    const configured = parseManifestReplayConfiguration({
      replay: { mode: "carry", bootstrap: { base, source, head } },
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
