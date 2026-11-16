// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Local automation history intentionally uses the host filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  CheckpointBuildReadyRecord,
  CheckpointEpisodeRecord,
} from "./lastcode-checkpoint-effort.mjs";

export interface CheckpointReplayStop {
  readonly replayId: string;
  readonly group: string;
  readonly commit: string;
  readonly kind: "fold" | "replay";
  readonly conflictedPaths: {
    readonly test: number;
    readonly generated: number;
    readonly other: number;
  };
}

export interface CheckpointAttemptFields {
  readonly episodeKey?: string;
  readonly attemptOrdinal?: number;
  readonly replayStops?: ReadonlyArray<CheckpointReplayStop>;
  readonly failingSteps?: ReadonlyArray<string>;
}

export interface CheckpointRunRecord extends CheckpointAttemptFields {
  readonly schemaVersion: 1;
  readonly status: "failed" | "success";
  readonly upstreamTag: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly commitsRebased: number;
  readonly checkpointCommit?: string;
  readonly checkpointTag?: string;
  readonly error?: string;
  readonly failurePhase?: "publication" | "rebase" | "smoke";
  readonly localTagRetained?: boolean;
  readonly recoveryBranch?: string;
  readonly recoveryFingerprint?: string;
  readonly conflictDossierPath?: string;
  readonly replayMode?: "carry" | "historical";
  readonly rollbackReason?: string;
  readonly sourceObjectRef?: string;
  readonly sourceCommit?: string;
}

export interface CarrySetShadowRecord {
  readonly schemaVersion: 1;
  readonly status: "shadow";
  readonly outcome: "failed" | "success";
  readonly checkpointTag: string;
  readonly baseCommit?: string;
  readonly sourceCommit?: string;
  readonly tree?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

export type CheckpointHistoryRecord =
  | CheckpointRunRecord
  | CarrySetShadowRecord
  | CheckpointEpisodeRecord
  | CheckpointBuildReadyRecord;

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function hasValidRollbackMetadata(candidate: Record<string, unknown>): boolean {
  return (
    candidate.rollbackReason === undefined ||
    (candidate.replayMode === "historical" &&
      typeof candidate.rollbackReason === "string" &&
      candidate.rollbackReason.trim() !== "")
  );
}

export function isCheckpointReplayStop(value: unknown): value is CheckpointReplayStop {
  if (!value || typeof value !== "object") return false;
  const stop = value as Record<string, unknown>;
  const paths = stop.conflictedPaths as Record<string, unknown> | undefined;
  return (
    typeof stop.replayId === "string" &&
    typeof stop.group === "string" &&
    typeof stop.commit === "string" &&
    (stop.kind === "fold" || stop.kind === "replay") &&
    !!paths &&
    [paths.test, paths.generated, paths.other].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    )
  );
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function checkpointFailingSteps(error: unknown): ReadonlyArray<string> {
  return error &&
    typeof error === "object" &&
    "failingSteps" in error &&
    isStringArray(error.failingSteps)
    ? error.failingSteps
    : [];
}

function failureStepNames(input: {
  readonly failingSteps?: ReadonlyArray<string>;
  readonly error?: unknown;
  readonly failurePhase?: CheckpointRunRecord["failurePhase"];
  readonly replayMode?: CheckpointRunRecord["replayMode"];
}): ReadonlyArray<string> {
  const names = (input.failingSteps ?? checkpointFailingSteps(input.error)).filter(
    (name) => name.trim() !== "",
  );
  if (names.length > 0) return names;
  return [
    input.failurePhase === "rebase"
      ? input.replayMode === "carry"
        ? "Carry replay"
        : "Historical replay"
      : input.failurePhase === "smoke"
        ? "Checkpoint validation"
        : input.failurePhase === "publication"
          ? "Checkpoint publication"
          : "Checkpoint attempt",
  ];
}

function isCheckpointRunRecord(record: unknown): record is CheckpointRunRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const candidate = record as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.status === "failed" || candidate.status === "success") &&
    typeof candidate.upstreamTag === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.finishedAt === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.commitsRebased === "number" &&
    isOptionalString(candidate.checkpointCommit) &&
    isOptionalString(candidate.checkpointTag) &&
    isOptionalString(candidate.error) &&
    (candidate.failurePhase === undefined ||
      candidate.failurePhase === "publication" ||
      candidate.failurePhase === "rebase" ||
      candidate.failurePhase === "smoke") &&
    isOptionalBoolean(candidate.localTagRetained) &&
    isOptionalString(candidate.recoveryBranch) &&
    isOptionalString(candidate.recoveryFingerprint) &&
    isOptionalString(candidate.conflictDossierPath) &&
    (candidate.replayMode === undefined ||
      candidate.replayMode === "carry" ||
      candidate.replayMode === "historical") &&
    hasValidRollbackMetadata(candidate) &&
    isOptionalString(candidate.sourceObjectRef) &&
    isOptionalString(candidate.sourceCommit) &&
    isOptionalString(candidate.episodeKey) &&
    (candidate.attemptOrdinal === undefined ||
      (typeof candidate.attemptOrdinal === "number" &&
        Number.isSafeInteger(candidate.attemptOrdinal) &&
        candidate.attemptOrdinal > 0)) &&
    (candidate.replayStops === undefined ||
      (Array.isArray(candidate.replayStops) &&
        candidate.replayStops.every(isCheckpointReplayStop))) &&
    (candidate.failingSteps === undefined || isStringArray(candidate.failingSteps))
  );
}

export function checkpointFailureRecord(
  input: CheckpointAttemptFields & {
    readonly commitsRebased: number;
    readonly error: unknown;
    readonly failurePhase?: "publication" | "rebase" | "smoke";
    readonly localTagRetained?: boolean;
    readonly recoveryBranch?: string;
    readonly recoveryFingerprint?: string;
    readonly replayMode?: "carry" | "historical";
    readonly rollbackReason?: string;
    readonly sourceObjectRef?: string;
    readonly sourceCommit?: string;
    readonly startedAtMs: number;
    readonly upstreamTag: string;
  },
  finishedAtMs = Date.now(),
): CheckpointRunRecord {
  const conflictDossierPath =
    input.error instanceof Error &&
    "conflictDossierPath" in input.error &&
    typeof input.error.conflictDossierPath === "string"
      ? input.error.conflictDossierPath
      : undefined;
  return {
    schemaVersion: 1,
    status: "failed",
    upstreamTag: input.upstreamTag,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - input.startedAtMs,
    commitsRebased: input.commitsRebased,
    ...(input.episodeKey ? { episodeKey: input.episodeKey } : {}),
    ...(input.attemptOrdinal ? { attemptOrdinal: input.attemptOrdinal } : {}),
    ...(input.replayStops ? { replayStops: input.replayStops } : {}),
    failingSteps: failureStepNames(input),
    error: input.error instanceof Error ? input.error.message : String(input.error),
    ...(input.failurePhase ? { failurePhase: input.failurePhase } : {}),
    ...(input.localTagRetained ? { localTagRetained: true } : {}),
    ...(input.recoveryBranch ? { recoveryBranch: input.recoveryBranch } : {}),
    ...(input.recoveryFingerprint ? { recoveryFingerprint: input.recoveryFingerprint } : {}),
    ...(conflictDossierPath ? { conflictDossierPath } : {}),
    ...(input.replayMode ? { replayMode: input.replayMode } : {}),
    ...(input.rollbackReason ? { rollbackReason: input.rollbackReason } : {}),
    ...(input.sourceObjectRef ? { sourceObjectRef: input.sourceObjectRef } : {}),
    ...(input.sourceCommit ? { sourceCommit: input.sourceCommit } : {}),
  };
}

export function checkpointRunHistoryPath(home = NodeOS.homedir()): string {
  return NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl");
}

export function checkpointRevisionRunHistoryPath(home = NodeOS.homedir()): string {
  return NodePath.join(home, ".lastcode", "automation", "checkpoint-revision-runs.jsonl");
}

export function readCheckpointRuns(
  historyPath = checkpointRunHistoryPath(),
): ReadonlyArray<CheckpointRunRecord> {
  try {
    return NodeFS.readFileSync(historyPath, "utf8")
      .split(/\r?\n/u)
      .flatMap((line) => {
        if (!line) return [];
        try {
          const record: unknown = JSON.parse(line);
          return isCheckpointRunRecord(record) ? [record] : [];
        } catch {
          // A process can be interrupted while appending. Other records remain usable.
          return [];
        }
      });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function readLatestCheckpointRun(
  historyPath = checkpointRunHistoryPath(),
): CheckpointRunRecord | undefined {
  return readCheckpointRuns(historyPath).at(-1);
}

export function checkpointReplayStopKey(stop: CheckpointReplayStop): string {
  return JSON.stringify([stop.replayId, stop.kind, stop.group, stop.commit]);
}

function attemptHistory(record: CheckpointRunRecord, historyPath: string): CheckpointRunRecord {
  const paths = new Set([
    historyPath,
    NodePath.join(NodePath.dirname(historyPath), "checkpoint-runs.jsonl"),
    NodePath.join(NodePath.dirname(historyPath), "checkpoint-revision-runs.jsonl"),
  ]);
  const allRecords = Array.from(paths).flatMap((path) => readCheckpointRuns(path));
  const previous = allRecords.filter((run) => run.upstreamTag === record.upstreamTag);
  const seenStops = new Set(
    allRecords.flatMap((run) => (run.replayStops ?? []).map(checkpointReplayStopKey)),
  );
  const replayStops = (record.replayStops ?? []).filter((stop) => {
    const key = checkpointReplayStopKey(stop);
    if (seenStops.has(key)) return false;
    seenStops.add(key);
    return true;
  });
  return {
    ...record,
    episodeKey: record.upstreamTag,
    attemptOrdinal:
      Math.max(previous.length, ...previous.map((run) => run.attemptOrdinal ?? 0)) + 1,
    replayStops,
    failingSteps: Array.from(
      new Set(record.status === "failed" ? failureStepNames(record) : (record.failingSteps ?? [])),
    ),
  };
}

// Checkpoint writes are serialized by their existing run lock. Isolate a torn tail first.
export function appendCheckpointHistoryLine(historyPath: string, record: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(historyPath), { recursive: true });
  const descriptor = NodeFS.openSync(historyPath, "a+", 0o600);
  try {
    const size = NodeFS.fstatSync(descriptor).size;
    const tail = Buffer.alloc(1);
    if (size > 0) NodeFS.readSync(descriptor, tail, 0, 1, size - 1);
    NodeFS.writeSync(
      descriptor,
      `${size > 0 && tail[0] !== 10 ? "\n" : ""}${JSON.stringify(record)}\n`,
    );
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

export function appendCheckpointRun(
  record: CheckpointHistoryRecord,
  historyPath = checkpointRunHistoryPath(),
  warn: (message: string) => void = console.warn,
): boolean {
  try {
    let enriched = record;
    if (record.status === "failed" || record.status === "success") {
      try {
        enriched = attemptHistory(record, historyPath);
      } catch {
        warn(
          "[lastcode:checkpoint] Could not enrich attempt history; retaining the checkpoint result.",
        );
      }
    }
    appendCheckpointHistoryLine(historyPath, enriched);
    return true;
  } catch (error) {
    warn(
      `[lastcode:checkpoint] Could not record dashboard history at ${historyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function appendCheckpointRevisionRun(
  record: CheckpointHistoryRecord,
  historyPath = checkpointRevisionRunHistoryPath(),
  warn: (message: string) => void = console.warn,
): boolean {
  return appendCheckpointRun(record, historyPath, warn);
}
