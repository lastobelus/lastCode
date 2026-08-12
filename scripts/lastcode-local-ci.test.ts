// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  assertCheckpointCiStamp,
  assertFullCiStamp,
  assertSupportedNodeVersion,
  parseLocalCiOptions,
  readFullCiStamp,
  resolveLocalCiSteps,
  verifyPreloadBundle,
  writeFullCiStamp,
} from "./lastcode-local-ci.ts";

describe("lastcode-local-ci", () => {
  it("requires the repository's supported Node release line", () => {
    expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.99.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.13.0")).toThrow("Node ^24.13.1");
    expect(() => assertSupportedNodeVersion("26.7.0")).toThrow("Node ^24.13.1");
  });

  it("defaults to the full gate and supports the quick pre-push gate", () => {
    expect(parseLocalCiOptions([])).toEqual({ mode: "full", dryRun: false });
    expect(parseLocalCiOptions(["--quick", "--", "--dry-run"])).toEqual({
      mode: "quick",
      dryRun: true,
    });
    expect(
      parseLocalCiOptions(["--checkpoint", "lastcode/checkpoint/v1.2.3-nightly.20260811.1"]),
    ).toEqual({
      mode: "full",
      dryRun: false,
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260811.1",
    });
  });

  it("keeps release, native, Rust, and preload checks in the full gate", () => {
    const quickLabels = resolveLocalCiSteps("quick").map(({ label }) => label);
    const fullLabels = resolveLocalCiSteps("full").map(({ label }) => label);

    expect(quickLabels).toEqual([
      "Ensure Electron runtime",
      "Format and lint",
      "Workspace typecheck",
      "Workspace tests",
    ]);
    expect(fullLabels).toEqual(
      expect.arrayContaining([
        "Resource monitor formatting",
        "Desktop build",
        "Desktop preload bundle assertions",
        "Resource monitor tests",
        "Mobile native static analysis",
        "Release smoke",
      ]),
    );
  });

  it("checks the built preload bridge contract", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-preload-test-"));
    const preloadPath = NodePath.join(root, "apps/desktop/dist-electron/preload.cjs");
    NodeFS.mkdirSync(NodePath.dirname(preloadPath), { recursive: true });
    NodeFS.writeFileSync(
      preloadPath,
      "desktopBridge getLocalEnvironmentBootstraps PICK_FOLDER_CHANNEL __clerk_internal_electron_passkeys",
    );

    expect(() => verifyPreloadBundle(root)).not.toThrow();
    NodeFS.writeFileSync(preloadPath, "desktopBridge");
    expect(() => verifyPreloadBundle(root)).toThrow("getLocalEnvironmentBootstraps");
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("binds a PR full-CI stamp to both the head and tested base commits", () => {
    const commonGitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-stamp-test-"));
    const stamp = {
      commit: "head-sha",
      completedAt: "2026-08-11T00:00:00.000Z",
      context: {
        kind: "pull-request" as const,
        baseCommit: "base-sha",
        baseRef: "lastcode/main" as const,
      },
    } as const;

    writeFullCiStamp(commonGitDir, stamp);
    expect(readFullCiStamp(commonGitDir, stamp.commit)).toEqual({ schemaVersion: 2, ...stamp });
    expect(assertFullCiStamp(commonGitDir, stamp.commit, stamp.context.baseCommit)).toEqual({
      schemaVersion: 2,
      ...stamp,
    });
    expect(() => assertFullCiStamp(commonGitDir, stamp.commit, "new-base-sha")).toThrow(
      "Rebase and rerun",
    );
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
  });

  it("binds a checkpoint full-CI stamp to its immutable tag and upstream commit", () => {
    const commonGitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-stamp-test-"));
    const checkpointTag = "lastcode/checkpoint/v1.2.3-nightly.20260811.1";
    const stamp = {
      commit: "checkpoint-sha",
      completedAt: "2026-08-11T00:00:00.000Z",
      context: {
        kind: "checkpoint" as const,
        checkpointTag,
        upstreamCommit: "upstream-sha",
        upstreamTag: "v1.2.3-nightly.20260811.1",
      },
    };

    writeFullCiStamp(commonGitDir, stamp);
    expect(
      assertCheckpointCiStamp(commonGitDir, stamp.commit, checkpointTag, "upstream-sha"),
    ).toEqual({ schemaVersion: 2, ...stamp });
    expect(() =>
      assertCheckpointCiStamp(commonGitDir, stamp.commit, checkpointTag, "new-upstream-sha"),
    ).toThrow("does not match checkpoint");
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
  });
});
