// Episode snapshots replace earlier snapshots with the same episodeKey; they are not deltas.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readEpisodeSource } from "./lastcode-checkpoint-effort-source.mjs";

export function readJsonLines(path) {
  try {
    return NodeFS.readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return value && typeof value === "object" ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function appendEpisodeRecord(path, record) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  // Leading newline isolates a partial append left by an interrupted writer.
  NodeFS.appendFileSync(path, `\n${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function collectCheckpointEpisode(input, readSource) {
  const { episodeKey, attempts, collectedAt, coordinatorThreadId } = input;
  const startedAt = attempts[0].startedAt;
  const windows = input.windows ?? [
    {
      startedAt,
      finishedAt: [input.build?.readyAt, input.finishedAt, collectedAt].filter(Boolean).sort()[0],
    },
  ];
  const finishedAt = windows.at(-1).finishedAt;
  const firstFailureAt = attempts.find((attempt) => attempt.status === "failed")?.finishedAt;
  const record = {
    schemaVersion: 1,
    status: "episode",
    episodeKey,
    upstreamTag: episodeKey,
    collectedAt,
    startedAt,
    finishedAt,
    windows,
    coordinatorThreadId: coordinatorThreadId ?? null,
    attempts: attempts.map((attempt, index) => ({
      attemptOrdinal: attempt.attemptOrdinal ?? index + 1,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      status: attempt.status,
      checkpointTag: attempt.checkpointTag ?? null,
      failingSteps: attempt.failingSteps ?? null,
      replayStops: attempt.replayStops ?? null,
    })),
    alerts: (input.incidents ?? []).map((incident) => ({
      openedAt: incident.openedAt,
      status: incident.alertDelivery,
      attemptedAt: incident.alertAttemptedAt ?? incident.lastDeliveryAttemptAt ?? null,
      deliveredAt: incident.alertDeliveredAt ?? null,
    })),
    timing: {
      firstAgentTurnAt: null,
      installableBuildReadyAt: input.build?.readyAt ?? null,
      revisionNeeded:
        input.build?.checkpointTag.startsWith("lastcode/revision/") ||
        attempts.some(
          (attempt) =>
            attempt.checkpointTag?.startsWith("lastcode/revision/") ||
            attempt.recoveryBranch?.startsWith("sync/revision"),
        )
          ? true
          : input.build
            ? false
            : null,
      authorizations: null,
      ownerInterruptions: null,
    },
  };
  try {
    if (!coordinatorThreadId) throw new Error("coordinator-unconfigured");
    const sources = windows.map((window) => readSource({ coordinatorThreadId, ...window }));
    const uniqueRows = (key) => [
      ...new Map(sources.flatMap((source) => source[key]).map((row) => [row.id, row])).values(),
    ];
    const source = {
      threadIds: [...new Set(sources.flatMap((source) => source.threadIds))],
      turns: uniqueRows("turns"),
      requests: uniqueRows("requests"),
      ownerMessages: uniqueRows("ownerMessages"),
      coverageMissing: [...new Set(sources.flatMap((source) => source.coverageMissing ?? []))],
    };
    if (
      source.coverageMissing?.some((reason) =>
        ["database-unavailable", "projection-unavailable"].includes(reason),
      )
    )
      throw new Error("source-unavailable");
    const turns = [...new Map(source.turns.map((turn) => [turn.id, turn])).values()];
    const missingUsageTurnIds = turns
      .filter(
        (turn) => !turn.usage || turn.usage.cachedInputTokens === undefined || !turn.completedAt,
      )
      .map((turn) => turn.id);
    const runs = [];
    for (const turn of turns) {
      let run = runs.find(
        (entry) => entry.threadId === turn.threadId && entry.runId === turn.runId,
      );
      if (!run) {
        run = { threadId: turn.threadId, runId: turn.runId, providerTurnIds: [] };
        runs.push(run);
      }
      run.providerTurnIds.push(turn.id);
    }
    const usage = turns.filter((turn) => turn.usage).map((turn) => turn.usage);
    const timingGaps = (source.coverageMissing ?? []).filter(
      (reason) =>
        !["turn-usage-unavailable:", "unattributed-other-usage:", "turn-run-unavailable:"].some(
          (prefix) => reason.startsWith(prefix),
        ),
    );
    const effortGaps = (source.coverageMissing ?? []).filter(
      (reason) => !reason.startsWith("owner-message-attribution:"),
    );
    record.effort = {
      status: missingUsageTurnIds.length || effortGaps.length ? "partial" : "complete",
      attribution: "whole-provider-turns-overlapping-episode",
      agentTurns: turns.length,
      inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
      cachedInputTokens: usage.reduce((sum, item) => sum + (item.cachedInputTokens ?? 0), 0),
      outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
      otherInputTokens: usage.reduce((sum, item) => sum + (item.otherUsage?.inputTokens ?? 0), 0),
      otherOutputTokens: usage.reduce((sum, item) => sum + (item.otherUsage?.outputTokens ?? 0), 0),
      threadIds: source.threadIds,
      runs,
      missingUsageTurnIds,
      coverageMissing: effortGaps,
      boundaryTurnIds: turns
        .filter(
          (turn) =>
            !windows.some(
              (window) =>
                turn.startedAt >= window.startedAt && turn.completedAt <= window.finishedAt,
            ),
        )
        .map((turn) => turn.id),
    };
    record.timing.firstAgentTurnAt = firstFailureAt
      ? (turns
          .filter((turn) => turn.startedAt !== null && turn.startedAt >= firstFailureAt)
          .map((turn) => turn.startedAt)
          .sort()[0] ?? null)
      : null;
    record.timing.authorizations = source.requests.filter((request) =>
      ["command", "file-read", "file-change", "mcp-elicitation", "permission"].includes(
        request.kind,
      ),
    );
    record.timing.ownerInterruptions = source.ownerMessages.length;
    record.timing.ownerMessages = source.ownerMessages;
    record.timing.coverageMissing = timingGaps;
    record.timing.ownerInterruptionsDefinition = "owner-web-mobile-messages";
  } catch {
    record.effort = {
      status: "missing",
      reason: coordinatorThreadId ? "source-unavailable" : "coordinator-unconfigured",
    };
  }
  return record;
}

function buildMatchesAttempt(record, attempt) {
  return (
    attempt.status === "success" &&
    typeof attempt.checkpointTag === "string" &&
    record.status === "build-ready" &&
    record.episodeKey === attempt.upstreamTag &&
    record.checkpointTag === attempt.checkpointTag &&
    record.readyAt >= attempt.finishedAt
  );
}

export function recordCheckpointEpisodes(options = {}) {
  const home = options.home ?? NodeOS.homedir();
  const directory = NodePath.join(home, ".lastcode", "automation");
  const path = NodePath.join(directory, "checkpoint-runs.jsonl");
  const records = readJsonLines(path);
  const revisions = readJsonLines(NodePath.join(directory, "checkpoint-revision-runs.jsonl"));
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const configPath = NodePath.join(directory, "checkpoint-supervisor.json");
  let config = {};
  try {
    config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
  } catch {
    /* Missing config is recorded below. */
  }
  const state =
    options.state ??
    (() => {
      try {
        return JSON.parse(
          NodeFS.readFileSync(NodePath.join(directory, "checkpoint-service-state.json"), "utf8"),
        );
      } catch {
        return {};
      }
    })();
  const incidents = [
    ...(state.pendingIncidents ?? []),
    ...(state.pendingResolutions ?? []),
    ...(state.incident ? [state.incident] : []),
  ];
  const episodes = new Map();
  for (const record of [...records, ...revisions]) {
    if (
      !["failed", "success"].includes(record.status) ||
      typeof record.upstreamTag !== "string" ||
      !record.startedAt
    )
      continue;
    if (!episodes.has(record.upstreamTag)) episodes.set(record.upstreamTag, []);
    episodes.get(record.upstreamTag).push(record);
  }
  const ordered = [...episodes.entries()]
    .map(([key, attempts]) => [
      key,
      attempts.sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    ])
    .sort((a, b) => a[1].at(-1).startedAt.localeCompare(b[1].at(-1).startedAt));
  const timeline = [...episodes.values()]
    .flat()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const segments = [];
  for (const attempt of timeline) {
    const previous = segments.at(-1);
    const closedByBuild =
      previous &&
      records.some(
        (record) =>
          buildMatchesAttempt(record, previous.lastAttempt) && record.readyAt <= attempt.startedAt,
      );
    if (previous?.episodeKey === attempt.upstreamTag && !closedByBuild)
      previous.lastAttempt = attempt;
    else {
      if (previous) previous.finishedAt = attempt.startedAt;
      segments.push({
        episodeKey: attempt.upstreamTag,
        startedAt: attempt.startedAt,
        finishedAt: collectedAt,
        lastAttempt: attempt,
      });
    }
  }
  const snapshots = [];
  for (let index = ordered.length - 1; index >= 0; index--) {
    const [episodeKey, attempts] = ordered[index];
    if (Date.parse(collectedAt) - Date.parse(attempts.at(-1).finishedAt) > 35 * 86400000) continue;
    const previous = records.findLast(
      (record) => record.status === "episode" && record.episodeKey === episodeKey,
    );
    const builds = records
      .filter((record) => record.status === "build-ready" && record.episodeKey === episodeKey)
      .sort((a, b) => a.readyAt.localeCompare(b.readyAt));
    const build = builds.find((record) => buildMatchesAttempt(record, attempts.at(-1)));
    const windows = segments
      .filter((segment) => segment.episodeKey === episodeKey)
      .map((segment) => ({
        startedAt: segment.startedAt,
        finishedAt: [
          segment.finishedAt,
          builds.find((record) => buildMatchesAttempt(record, segment.lastAttempt))?.readyAt,
          collectedAt,
        ]
          .filter(Boolean)
          .sort()[0],
      }));
    const matchingIncidents = incidents.filter(
      (incident) => incident.failure?.checkpointRun?.upstreamTag === episodeKey,
    );
    const snapshot = collectCheckpointEpisode(
      {
        episodeKey,
        attempts,
        collectedAt,
        windows,
        coordinatorThreadId:
          options.coordinatorThreadId ??
          matchingIncidents.find((incident) => incident.deliveryThreadId)?.deliveryThreadId ??
          previous?.coordinatorThreadId ??
          config.recoveryThreadId,
        incidents: matchingIncidents,
        build,
      },
      options.readSource ??
        ((input) =>
          readEpisodeSource({
            ...input,
            databasePath:
              config.effortDatabasePath ??
              NodePath.join(home, ".lastcode", "userdata", "statev2.sqlite"),
          })),
    );
    snapshot.alerts = [
      ...new Map(
        [...(previous?.alerts ?? []), ...snapshot.alerts].map((alert) => [alert.openedAt, alert]),
      ).values(),
    ];
    const comparable = ({ collectedAt: _collectedAt, ...value }) => {
      // An open window advances even when no measured work or timing changed.
      if (!build && segments.at(-1)?.episodeKey === episodeKey) {
        delete value.finishedAt;
        value.windows = value.windows?.map((window, index, all) =>
          index === all.length - 1 ? { ...window, finishedAt: undefined } : window,
        );
      }
      return JSON.stringify(value);
    };
    if (previous && comparable(previous) === comparable(snapshot)) continue;
    appendEpisodeRecord(path, snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}

export function recordInstallableBuildReady(build, options = {}) {
  try {
    const home = options.home ?? NodeOS.homedir();
    appendEpisodeRecord(NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl"), {
      schemaVersion: 1,
      status: "build-ready",
      episodeKey: build.upstreamTag,
      checkpointTag: build.checkpointTag,
      readyAt: build.builtAt,
    });
    recordCheckpointEpisodes({ ...options, home });
  } catch {
    console.error(
      "[lastcode:checkpoint] Build timing collection unavailable; build result unchanged.",
    );
  }
}

if (import.meta.main) {
  try {
    recordCheckpointEpisodes();
  } catch {
    console.error(
      "[lastcode:checkpoint] Episode collection unavailable; checkpoint result unchanged.",
    );
  }
}
