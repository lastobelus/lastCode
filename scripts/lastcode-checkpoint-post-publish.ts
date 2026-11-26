// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Local checkpoint publication uses native processes and filesystem state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  checkpointPostPublishPendingPath,
  type CheckpointPostPublishTarget,
} from "./lib/lastcode-checkpoint-service-run-now.mjs";

// @effect-diagnostics-next-line extendsNativeError:off -- The checkpoint CLI uses this error to choose its exit status.
export class CheckpointPostPublishError extends Error {}

function recordActivity(event: Record<string, unknown>): void {
  const runId = process.env.LASTCODE_CHECKPOINT_SUPERVISOR_RUN_ID;
  if (!runId) return;
  const launchdPid = Number(process.env.LASTCODE_CHECKPOINT_SUPERVISOR_LAUNCHD_PID);
  try {
    NodeFS.appendFileSync(
      NodePath.join(
        NodeOS.homedir(),
        ".lastcode",
        "automation",
        "checkpoint-service-activity.jsonl",
      ),
      `${JSON.stringify({ schemaVersion: 1, runId, supervisorPid: process.ppid, launchdPid, phase: "post-publish", ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    console.error("[lastcode:checkpoint] Could not record post-publish activity.");
  }
}

function readCommand(): readonly [string, ...string[]] | undefined {
  const path = NodePath.join(
    NodeOS.homedir(),
    ".lastcode",
    "automation",
    "checkpoint-supervisor.json",
  );
  let config: { readonly postPublishCommand?: unknown } | null;
  try {
    config = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const command = config?.postPublishCommand;
  if (command === undefined) return;
  if (
    !Array.isArray(command) ||
    typeof command[0] !== "string" ||
    !command[0].trim() ||
    !command.every((argument) => typeof argument === "string" && !argument.includes("\0"))
  ) {
    throw new CheckpointPostPublishError(
      "postPublishCommand must be an executable followed by string arguments.",
    );
  }
  return [command[0], ...command.slice(1)];
}

export function checkpointPostPublishGate(
  repoRoot: string,
  commonDirectory: string,
  options: { readonly pushRemote: string; readonly revisionOnly?: string },
  pending: CheckpointPostPublishTarget | undefined,
) {
  const { pushRemote: remote } = options;
  const command = readCommand();
  const path = checkpointPostPublishPendingPath(commonDirectory);
  let prepared: CheckpointPostPublishTarget | undefined;

  function complete(target: CheckpointPostPublishTarget): void {
    const { tag, commit } = target;
    if (!command) {
      throw new CheckpointPostPublishError(
        `Checkpoint ${tag} still requires a post-publish command.`,
      );
    }
    console.log(`[lastcode:checkpoint] Running post-publish command for ${tag} at ${commit}.`);
    const [executable, ...args] = command;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    recordActivity({ event: "phase-start", startedAt });
    let outcome = "threw";
    try {
      const result = NodeChildProcess.spawnSync(executable, args, {
        cwd: repoRoot,
        env: { ...process.env, LASTCODE_CHECKPOINT_TAG: tag, LASTCODE_CHECKPOINT_SHA: commit },
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (result.error || result.status !== 0) {
        const detail = result.error
          ? "could not start"
          : result.signal
            ? `was terminated by ${result.signal}`
            : `failed with exit code ${result.status ?? "unknown"}`;
        throw new CheckpointPostPublishError(
          `Checkpoint post-publish command for ${tag} ${detail}.`,
        );
      }
      NodeFS.unlinkSync(path);
      outcome = "returned";
    } finally {
      recordActivity({
        event: "phase-finish",
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        outcome,
      });
    }
  }

  return {
    prepare(tag: string, commit: string): void {
      if (!command) return;
      const target: CheckpointPostPublishTarget = {
        tag,
        commit,
        remote,
        ...(options.revisionOnly ? { revisionOnly: true } : {}),
      };
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        NodeFS.writeFileSync(temporary, `${JSON.stringify(target)}\n`, { mode: 0o600 });
        NodeFS.renameSync(temporary, path);
      } finally {
        NodeFS.rmSync(temporary, { force: true });
      }
      prepared = target;
    },
    finishPublication(): void {
      if (!prepared) return;
      complete(prepared);
      prepared = undefined;
    },
    retry(
      resolvePublishedCommit: (tag: string) => string | undefined,
    ): CheckpointPostPublishTarget | undefined {
      if (!pending) return;
      if (pending.remote !== remote) {
        throw new CheckpointPostPublishError(
          "Retry the pending checkpoint post-publish command with its original push remote.",
        );
      }
      const publishedCommit = resolvePublishedCommit(pending.tag);
      if (!publishedCommit) {
        NodeFS.unlinkSync(path);
        return;
      }
      if (publishedCommit !== pending.commit) {
        throw new CheckpointPostPublishError(
          `Published checkpoint ${pending.tag} changed before its post-publish command could be retried.`,
        );
      }
      complete(pending);
      return pending;
    },
  };
}
