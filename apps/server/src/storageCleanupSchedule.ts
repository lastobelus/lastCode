// @effect-diagnostics nodeBuiltinImport:off - Time Machine status is exposed by macOS through tmutil.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export const BACKUP_RETRY_DELAY = "5 minutes";

export type AutomaticSweepRequest = {
  readonly full: boolean;
  readonly scheduled: boolean;
  readonly targetPaths: ReadonlyArray<string>;
};

export function mergeSweepRequests(
  pending: AutomaticSweepRequest,
  request: Partial<AutomaticSweepRequest>,
) {
  return {
    full: pending.full || request.full === true,
    scheduled: pending.scheduled || request.scheduled === true,
    targetPaths: [...new Set([...pending.targetPaths, ...(request.targetPaths ?? [])])],
  };
}

export type ScheduledSweepGroup = "outputs" | "housekeeping";

export function cleanupSweepGroup(
  request: AutomaticSweepRequest | undefined,
  alternateGroups: boolean,
  next: ScheduledSweepGroup,
): ScheduledSweepGroup | "all" {
  return alternateGroups &&
    request?.scheduled === true &&
    !request.full &&
    request.targetPaths.length === 0
    ? next
    : "all";
}

type BackupStatus = "idle" | "running" | "unknown";

export class TimeMachineBackupStatus extends Context.Reference<Effect.Effect<BackupStatus>>(
  "lastcode/TimeMachineBackupStatus",
  {
    defaultValue: Effect.fn("TimeMachineBackupStatus.read")(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return "idle" as const;
      return yield* Effect.tryPromise({
        try: (signal) =>
          new Promise<string>((resolve, reject) => {
            NodeChildProcess.execFile(
              "/usr/bin/tmutil",
              ["status"],
              { signal, timeout: 5_000, maxBuffer: 32 * 1024 },
              (error, stdout) => (error ? reject(error) : resolve(stdout)),
            );
          }),
        catch: () => "unknown" as const,
      }).pipe(
        Effect.map((status): BackupStatus => {
          const running = /^\s*Running = ([01]);\s*$/m.exec(status)?.[1];
          return running === "0" ? "idle" : running === "1" ? "running" : "unknown";
        }),
        Effect.orElseSucceed(() => "unknown" as const),
      );
    }),
  },
) {}

export const runCleanupTimer = Effect.fnUntraced(function* (
  firstDelay: Duration.Duration,
  interval: () => Duration.Duration,
  intervalChanges: Queue.Dequeue<void>,
  run: Effect.Effect<void>,
) {
  let delay = firstDelay;
  while (true) {
    const due = yield* Effect.race(
      Effect.sleep(delay).pipe(Effect.as(true)),
      Queue.take(intervalChanges).pipe(Effect.as(false)),
    );
    if (due) yield* run;
    delay = interval();
  }
});
