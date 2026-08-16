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
}

export function checkpointFailureRecord(
  input: {
    readonly commitsRebased: number;
    readonly error: unknown;
    readonly failurePhase?: "publication" | "rebase" | "smoke";
    readonly localTagRetained?: boolean;
    readonly recoveryBranch?: string;
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
  };
}

export function checkpointRunHistoryPath(home = NodeOS.homedir()): string {
  return NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl");
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
