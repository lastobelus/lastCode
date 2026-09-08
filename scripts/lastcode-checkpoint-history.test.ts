// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  appendCheckpointRun,
  checkpointFailureRecord,
  checkpointRunHistoryPath,
  readLatestCheckpointRun,
} from "./lastcode-checkpoint-history.ts";

describe("checkpoint run history", () => {
  it("uses the private LastCode automation directory", () => {
    expect(checkpointRunHistoryPath("/Users/example")).toBe(
      "/Users/example/.lastcode/automation/checkpoint-runs.jsonl",
    );
  });

  it("does not let dashboard history failures change checkpoint results", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const warnings: Array<string> = [];

    expect(
      appendCheckpointRun(
        {
          schemaVersion: 1,
          status: "success",
          upstreamTag: "v0.0.1-nightly.20260812.1",
          startedAt: "2026-08-12T00:00:00.000Z",
          finishedAt: "2026-08-12T00:00:01.000Z",
          durationMs: 1_000,
          commitsRebased: 1,
          replayMode: "carry",
          sourceObjectRef: "refs/lastcode/sources/v1",
        },
        directory,
        (message) => warnings.push(message),
      ),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not record dashboard history");
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("builds failure history without replacing the original error", () => {
    expect(
      checkpointFailureRecord(
        {
          commitsRebased: 3,
          error: new Error("push failed"),
          failurePhase: "publication",
          localTagRetained: true,
          startedAtMs: 1_000,
          upstreamTag: "v0.0.1-nightly.20260812.1",
          replayMode: "historical",
          rollbackReason: "compiler regression",
        },
        4_000,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "failed",
      upstreamTag: "v0.0.1-nightly.20260812.1",
      startedAt: "1970-01-01T00:00:01.000Z",
      finishedAt: "1970-01-01T00:00:04.000Z",
      durationMs: 3_000,
      commitsRebased: 3,
      error: "push failed",
      failurePhase: "publication",
      localTagRetained: true,
      replayMode: "historical",
      rollbackReason: "compiler regression",
    });
  });

  it("reads the latest complete history record after an interrupted append", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    const record = checkpointFailureRecord({
      commitsRebased: 3,
      error: new Error("rebase failed"),
      failurePhase: "rebase",
      recoveryBranch: "sync/nightly/v0.0.1-nightly.20260812.1",
      recoveryFingerprint: "fingerprint-1",
      startedAtMs: 1_000,
      upstreamTag: "v0.0.1-nightly.20260812.1",
    });
    NodeFS.writeFileSync(historyPath, `${JSON.stringify(record)}\n{"incomplete"`);

    expect(readLatestCheckpointRun(historyPath)).toEqual(record);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("skips malformed recovery metadata and uses the previous valid record", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    const record = checkpointFailureRecord({
      commitsRebased: 3,
      error: new Error("rebase failed"),
      failurePhase: "rebase",
      recoveryBranch: "sync/nightly/v0.0.1-nightly.20260812.1",
      recoveryFingerprint: "fingerprint-1",
      startedAtMs: 1_000,
      upstreamTag: "v0.0.1-nightly.20260812.1",
    });
    NodeFS.writeFileSync(
      historyPath,
      `${JSON.stringify(record)}\n${JSON.stringify({ ...record, recoveryBranch: 42 })}\n`,
    );

    expect(readLatestCheckpointRun(historyPath)).toEqual(record);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("skips contradictory rollback metadata", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    const record = checkpointFailureRecord({
      commitsRebased: 0,
      error: new Error("carry replay failed"),
      replayMode: "carry",
      startedAtMs: 1_000,
      upstreamTag: "v0.0.1-nightly.20260812.1",
    });
    NodeFS.writeFileSync(
      historyPath,
      `${JSON.stringify(record)}\n${JSON.stringify({ ...record, rollbackReason: "compiler regression" })}\n`,
    );

    expect(readLatestCheckpointRun(historyPath)).toEqual(record);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("keeps shadow results from replacing the latest checkpoint run", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-history-"));
    const historyPath = NodePath.join(directory, "checkpoint-runs.jsonl");
    const record = checkpointFailureRecord({
      commitsRebased: 3,
      error: new Error("rebase failed"),
      failurePhase: "rebase",
      startedAtMs: 1_000,
      upstreamTag: "v0.0.1-nightly.20260812.1",
    });
    NodeFS.writeFileSync(
      historyPath,
      `${JSON.stringify(record)}\n${JSON.stringify({
        schemaVersion: 1,
        status: "shadow",
        outcome: "success",
        checkpointTag: "lastcode/checkpoint/v0.0.1-nightly.20260812.1",
        startedAt: "1970-01-01T00:00:02.000Z",
        finishedAt: "1970-01-01T00:00:03.000Z",
        durationMs: 1_000,
      })}\n`,
    );

    expect(readLatestCheckpointRun(historyPath)).toEqual(record);
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
});
