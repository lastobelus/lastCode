import * as NodeSqlite from "node:sqlite";

const count = (value) => Number.isSafeInteger(value) && value >= 0;

function turnUsage(payload) {
  // tokenUsage measures context; only turnTokenUsage reports accumulated model work.
  const usage = payload.turnTokenUsage;
  if (
    usage?.usageStatus !== "complete" ||
    !count(usage.inputTokens) ||
    !count(usage.outputTokens) ||
    (usage.cachedInputTokens !== undefined &&
      (!count(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens))
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    outputTokens: usage.outputTokens,
    ...(usage.otherUsage &&
    count(usage.otherUsage.inputTokens) &&
    count(usage.otherUsage.outputTokens)
      ? { otherUsage: usage.otherUsage }
      : {}),
  };
}

/** Read a consistent projection snapshot without initializing or migrating the source database. */
export function readEpisodeSource({ databasePath, coordinatorThreadId, startedAt, finishedAt }) {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) {
    throw new TypeError("A valid episode time window is required.");
  }
  const result = {
    threadIds: [coordinatorThreadId],
    turns: [],
    requests: [],
    ownerMessages: [],
    coverageMissing: [],
  };
  let database;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    result.coverageMissing.push("database-unavailable");
    return result;
  }
  try {
    database.exec("BEGIN");
    const missing = new Set();
    const threadIds = new Set([coordinatorThreadId]);
    const turns = new Map();
    const nativeTasks = [];
    const thread = database.prepare(
      "SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?",
    );
    const children = database.prepare(`
      SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
      WHERE CAST(json_extract(payload_json, '$.lineage.parentThreadId') AS TEXT) = ?
        AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      ORDER BY thread_id
    `);
    const tasks = database.prepare(`
      SELECT subagent_id, run_id, child_thread_id, provider_thread_id, origin,
        started_at, completed_at, payload_json
      FROM orchestration_v2_projection_subagents WHERE thread_id = ? ORDER BY subagent_id
    `);
    const turnSelect = `
      SELECT t.provider_turn_id, t.thread_id, t.provider_thread_id,
        COALESCE(a.run_id, n.run_id) AS run_id, t.started_at, t.completed_at, t.payload_json
      FROM orchestration_v2_projection_provider_turns t
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
      LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = t.node_id
    `;
    const threadTurns = database.prepare(`${turnSelect} WHERE t.thread_id = ?`);
    const nativeTurns = database.prepare(`${turnSelect} WHERE t.provider_thread_id = ?`);
    const requests = database.prepare(`
      SELECT runtime_request_id, thread_id, kind, created_at, resolved_at, status, payload_json
      FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ?
      ORDER BY created_at, runtime_request_id
    `);
    const messages = database.prepare(`
      SELECT message_id, thread_id, created_at,
        json_extract(payload_json, '$.creationSource') AS source
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ? AND role = 'user'
        AND json_extract(payload_json, '$.createdBy') = 'user'
      ORDER BY created_at, message_id
    `);
    const inWindow = (at) => Date.parse(at) >= start && Date.parse(at) < finish;
    // Whole overlapping turns are returned; the episode builder labels that attribution.
    const overlaps = (from, to) =>
      (from === null || Date.parse(from) < finish) && (to === null || Date.parse(to) > start);
    const addThread = (id) => {
      const row = thread.get(id);
      if (!row) {
        missing.add(`thread-missing:${id}`);
        threadIds.add(id);
        return true;
      }
      if (JSON.parse(row.payload_json).lineage?.independent === true) return false;
      threadIds.add(id);
      return true;
    };
    const addTurn = (row) => {
      if (!overlaps(row.started_at, row.completed_at)) return;
      turns.set(row.provider_turn_id, row);
    };
    if (!thread.get(coordinatorThreadId)) {
      missing.add(`thread-missing:${coordinatorThreadId}`);
    }
    // Set iteration visits newly discovered descendants and terminates even with cyclic lineage.
    for (const id of threadIds) {
      for (const row of threadTurns.all(id)) addTurn(row);
      const localTasks = tasks.all(id);
      for (const task of localTasks) {
        const payload = JSON.parse(task.payload_json);
        if (!overlaps(task.started_at, task.completed_at)) continue;
        if (payload.ownershipReleased === true) {
          missing.add(`released-child-history-unavailable:${task.subagent_id}`);
          continue;
        }
        if (payload.remoteChild || payload.remoteLaunch) {
          missing.add(`remote-child:${task.subagent_id}`);
          continue;
        }
        if (task.child_thread_id && !addThread(task.child_thread_id)) {
          missing.add(`child-ownership-unavailable:${task.subagent_id}`);
          continue;
        }
        if (task.origin === "provider_native") {
          nativeTasks.push({ ...task, parentThreadId: id });
          if (task.provider_thread_id) {
            for (const row of nativeTurns.all(task.provider_thread_id)) {
              if (row.thread_id === id || addThread(row.thread_id)) addTurn(row);
            }
          }
        } else if (!task.child_thread_id) {
          missing.add(`local-child-unrepresented:${task.subagent_id}`);
        }
      }
      // Native/imported lineage can survive without its parent's subagent projection.
      const knownChildren = new Set(localTasks.map((task) => task.child_thread_id));
      for (const child of children.all(id)) {
        if (
          !knownChildren.has(child.thread_id) &&
          threadTurns
            .all(child.thread_id)
            .some((turn) => overlaps(turn.started_at, turn.completed_at)) &&
          addThread(child.thread_id)
        ) {
          missing.add(`child-task-missing:${child.thread_id}`);
        }
      }
      for (const request of requests.all(id)) {
        if (!overlaps(request.created_at, request.resolved_at) && !inWindow(request.resolved_at)) {
          continue;
        }
        const payload = JSON.parse(request.payload_json);
        result.requests.push({
          id: request.runtime_request_id,
          threadId: id,
          kind: request.kind,
          createdAt: request.created_at,
          resolvedAt: request.resolved_at,
          status: request.status,
          ...(payload.decision === undefined ? {} : { decision: payload.decision }),
        });
      }
      for (const message of messages.all(id)) {
        if (!inWindow(message.created_at)) continue;
        if (message.source !== "web" && message.source !== "mobile") {
          // CLI automation also records user/server messages; it cannot prove owner involvement.
          missing.add(`owner-message-attribution:${message.message_id}`);
          continue;
        }
        result.ownerMessages.push({
          id: message.message_id,
          threadId: id,
          createdAt: message.created_at,
        });
      }
    }
    for (const task of nativeTasks) {
      if (
        ![...turns.values()].some(
          (turn) =>
            (task.provider_thread_id !== null &&
              turn.provider_thread_id === task.provider_thread_id) ||
            (task.child_thread_id !== null && turn.thread_id === task.child_thread_id),
        )
      ) {
        missing.add(`native-subagent-unrepresented:${task.subagent_id}`);
      }
    }
    for (const row of turns.values()) {
      const payload = JSON.parse(row.payload_json);
      const usage = turnUsage(payload);
      if (
        payload.turnTokenUsage?.otherUsage &&
        (payload.turnTokenUsage.otherUsage.inputTokens > 0 ||
          payload.turnTokenUsage.otherUsage.outputTokens > 0)
      ) {
        missing.add(`unattributed-other-usage:${row.provider_turn_id}`);
      }
      if (usage === null) missing.add(`turn-usage-unavailable:${row.provider_turn_id}`);
      if (row.run_id === null) missing.add(`turn-run-unavailable:${row.provider_turn_id}`);
      if (row.started_at === null) missing.add(`turn-start-unavailable:${row.provider_turn_id}`);
      if (
        payload.turnTokenUsage?.hasSubagents &&
        !nativeTasks.some(
          (task) => task.parentThreadId === row.thread_id && task.run_id === row.run_id,
        )
      ) {
        missing.add(`native-subagent-unrepresented:${row.provider_turn_id}`);
      }
      result.turns.push({
        id: row.provider_turn_id,
        threadId: row.thread_id,
        runId: row.run_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        usage,
      });
    }
    result.threadIds = [...threadIds];
    result.turns.sort(
      (a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id),
    );
    result.coverageMissing = [...missing].sort();
    return result;
  } catch {
    return {
      ...result,
      turns: [],
      requests: [],
      ownerMessages: [],
      coverageMissing: ["projection-unavailable"],
    };
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
}
