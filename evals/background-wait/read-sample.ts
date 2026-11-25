// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import type {
  ActionResumeState,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { actionResumeStatus } from "@t3tools/shared/actionResume";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { existingFile } from "./paths.ts";
import type { Snapshot } from "./sample.ts";

export function openSampleDatabase(home: string) {
  const url = NodeURL.pathToFileURL(
    existingFile(home, NodePath.join(home, "userdata/statev2.sqlite")),
  );
  // A read-only SQLite connection can still write its WAL index unless the VFS opens it read-only too.
  url.searchParams.set("readonly_shm", "1");
  return new NodeSqlite.DatabaseSync(url.href, { readOnly: true });
}

const activeStatuses = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export function readOnlySnapshots(db: NodeSqlite.DatabaseSync) {
  const threadRow = db.prepare(`
    SELECT payload_json FROM orchestration_v2_projection_threads
    WHERE thread_id = ? AND deleted_at IS NULL
  `);
  const runs = db.prepare(`
    SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC
  `);
  const pendingRequests = db.prepare(`
    SELECT COUNT(*) AS count FROM orchestration_v2_projection_runtime_requests
    WHERE thread_id = ? AND status = 'pending'
  `);
  const providerThreads = db.prepare(`
    SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?
  `);
  const backgroundItems = db.prepare(`
    SELECT payload_json FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status IN ('pending', 'running', 'waiting')
  `);
  const lastAssistant = db.prepare(`
    SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
    WHERE thread_id = ? AND role = 'assistant'
    ORDER BY created_at DESC, message_id DESC LIMIT 1
  `);
  const latestAction = db.prepare(`
    SELECT action.state_json, message.run_id AS follow_up FROM action_resume_runs AS action
    LEFT JOIN orchestration_v2_projection_messages AS message
      ON message.thread_id = action.thread_id
      AND message.message_id = 'action-resume:' || action.run_id || ':follow-up'
    WHERE action.thread_id = ? ORDER BY action.ordinal DESC LIMIT 1
  `);

  type BackgroundInput = Parameters<typeof derivePendingBackgroundWork>[0];
  const read = (threadId: string): Snapshot => {
    const row = threadRow.get(threadId);
    if (!row) throw new Error(`No thread ${threadId} in the selected database.`);
    const thread = JSON.parse(
      String(row.payload_json),
    ) as OrchestrationV2ThreadProjection["thread"];
    const runRows = runs
      .all(threadId)
      .map((run) => JSON.parse(String(run.payload_json)) as OrchestrationV2Run);
    const active = runRows.find((run) => activeStatuses.has(run.status));
    const latestRun = runRows[0];
    const pendingRequestCount = Number(pendingRequests.get(threadId)?.count);
    const pendingBackgroundTasks = derivePendingBackgroundWork({
      latestRun,
      runs: runRows,
      activeProviderThreadId: thread.activeProviderThreadId,
      providerThreads: providerThreads
        .all(threadId)
        .map((provider) =>
          JSON.parse(String(provider.payload_json)),
        ) as BackgroundInput["providerThreads"],
      turnItems: backgroundItems
        .all(threadId)
        .map((item) => JSON.parse(String(item.payload_json))) as BackgroundInput["turnItems"],
      pullRequests: thread.pullRequests,
    });
    const actionRow = latestAction.get(threadId);
    const action = actionRow && (JSON.parse(String(actionRow.state_json)) as ActionResumeState);
    const status = latestRun?.status ?? "idle";
    const message = lastAssistant.get(threadId)?.text;
    return {
      thread: {
        threadId,
        status:
          active?.status ??
          (status !== "failed" && backgroundWorkHoldsCompletion(pendingBackgroundTasks)
            ? "waiting"
            : status),
        activeRunId: active?.id ?? null,
        runCount: runRows.length,
        pendingRequestCount,
        worktreePath: thread.worktreePath,
        model: thread.modelSelection.model,
        providerInstanceId: thread.modelSelection.instanceId,
        pendingBackgroundTasks,
        actionResume: action
          ? {
              runId: action.runId,
              actionId: action.actionId,
              delivery: action.delivery,
              status: actionResumeStatus({
                action,
                environmentPaused: false,
                followUp: runRows.find((run) => run.id === actionRow?.follow_up),
                hasPendingRequest: pendingRequestCount > 0,
              }),
            }
          : null,
      },
      messages: typeof message === "string" ? [{ role: "assistant", text: message }] : [],
    };
  };
  return (threadIds: readonly string[]) => {
    db.exec("BEGIN");
    try {
      return threadIds.map(read);
    } finally {
      db.exec("ROLLBACK");
    }
  };
}

export function retainedActionHoldIds(
  db: NodeSqlite.DatabaseSync,
  threadId: string,
  actionId: string,
) {
  return db
    .prepare(`
    SELECT run_id FROM action_resume_runs
    WHERE thread_id = ? AND json_extract(state_json, '$.actionId') = ?
      AND json_extract(state_json, '$.delivery') IN ('armed', 'pending', 'delivered')
  `)
    .all(threadId, actionId)
    .map(({ run_id }) => String(run_id));
}
