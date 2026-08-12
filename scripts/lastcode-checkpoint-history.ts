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
  readonly recoveryBranch?: string;
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
