// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Local automation history intentionally uses the host filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface CheckpointRunRecord {
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
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
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
    isOptionalString(candidate.recoveryFingerprint)
  );
}

export function checkpointFailureRecord(
  input: {
    readonly commitsRebased: number;
    readonly error: unknown;
    readonly failurePhase?: "publication" | "rebase" | "smoke";
    readonly localTagRetained?: boolean;
    readonly recoveryBranch?: string;
    readonly recoveryFingerprint?: string;
    readonly startedAtMs: number;
    readonly upstreamTag: string;
  },
  finishedAtMs = Date.now(),
): CheckpointRunRecord {
  return {
    schemaVersion: 1,
    status: "failed",
    upstreamTag: input.upstreamTag,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - input.startedAtMs,
    commitsRebased: input.commitsRebased,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    ...(input.failurePhase ? { failurePhase: input.failurePhase } : {}),
    ...(input.localTagRetained ? { localTagRetained: true } : {}),
    ...(input.recoveryBranch ? { recoveryBranch: input.recoveryBranch } : {}),
    ...(input.recoveryFingerprint ? { recoveryFingerprint: input.recoveryFingerprint } : {}),
  };
}

export function checkpointRunHistoryPath(home = NodeOS.homedir()): string {
  return NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl");
}

export function readLatestCheckpointRun(
  historyPath = checkpointRunHistoryPath(),
): CheckpointRunRecord | undefined {
  try {
    const lines = NodeFS.readFileSync(historyPath, "utf8").trim().split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isCheckpointRunRecord(record)) return record;
      } catch {
        // A process can be interrupted while appending. Older valid records remain usable.
      }
    }
    return undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function appendCheckpointRun(
  record: CheckpointRunRecord,
  historyPath = checkpointRunHistoryPath(),
  warn: (message: string) => void = console.warn,
): boolean {
  try {
    NodeFS.mkdirSync(NodePath.dirname(historyPath), { recursive: true });
    NodeFS.appendFileSync(historyPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    warn(
      `[lastcode:checkpoint] Could not record dashboard history at ${historyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
