import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readLatestCheckpointRun } from "./lastcode-checkpoint-history.ts";
import {
  collectCheckpointEpisode,
  readJsonLines,
  recordCheckpointEpisodes,
  recordInstallableBuildReady,
} from "./lastcode-checkpoint-effort.mjs";

const tag = "v9.9.9-nightly.20990101.1";
const at = (minute) => `2099-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const attempts = [
  {
    schemaVersion: 1,
    durationMs: 60000,
    commitsRebased: 2,
    status: "failed",
    upstreamTag: tag,
    startedAt: at(0),
    finishedAt: at(1),
    failingSteps: ["replay"],
  },
  {
    schemaVersion: 1,
    durationMs: 120000,
    commitsRebased: 6,
    status: "success",
    upstreamTag: tag,
    checkpointTag: `lastcode/checkpoint/${tag}`,
    startedAt: at(10),
    finishedAt: at(12),
  },
];
const source = {
  threadIds: ["maintenance", "child"],
  turns: [
    {
      id: "turn-1",
      threadId: "maintenance",
      runId: "run-1",
      startedAt: at(3),
      completedAt: at(6),
      usage: { inputTokens: 100, cachedInputTokens: 70, outputTokens: 10 },
    },
    {
      id: "turn-2",
      threadId: "child",
      runId: "run-2",
      startedAt: at(4),
      completedAt: at(5),
      usage: { inputTokens: 40, cachedInputTokens: 30, outputTokens: 5 },
    },
  ],
  requests: [
    {
      id: "permission-1",
      threadId: "maintenance",
      kind: "command",
      createdAt: at(5),
      resolvedAt: at(6),
      status: "resolved",
    },
  ],
  ownerMessages: [{ id: "message-1", threadId: "maintenance", createdAt: at(7) }],
};

describe("checkpoint episode effort", () => {
  it("reconstructs retries, children, delivery, authorization and build readiness in one episode", () => {
    const result = collectCheckpointEpisode(
      {
        episodeKey: tag,
        attempts,
        coordinatorThreadId: "maintenance",
        collectedAt: at(20),
        incidents: [
          {
            openedAt: at(1),
            alertDelivery: "sent",
            lastDeliveryAttemptAt: at(2),
            failure: { checkpointRun: attempts[0] },
          },
        ],
        build: { checkpointTag: `lastcode/revision/${tag}.1`, readyAt: at(18) },
      },
      () => source,
    );
    expect(result.effort).toMatchObject({
      status: "complete",
      agentTurns: 2,
      inputTokens: 140,
      cachedInputTokens: 100,
      outputTokens: 15,
    });
    expect(result.effort.runs).toEqual([
      { threadId: "maintenance", runId: "run-1", providerTurnIds: ["turn-1"] },
      { threadId: "child", runId: "run-2", providerTurnIds: ["turn-2"] },
    ]);
    expect(result.timing).toMatchObject({
      firstAgentTurnAt: at(3),
      installableBuildReadyAt: at(18),
      revisionNeeded: true,
      ownerInterruptions: 1,
      authorizations: source.requests,
    });
    expect(result.alerts[0]).toMatchObject({ status: "sent", attemptedAt: at(2) });
    expect(result.attempts).toHaveLength(2);
  });

  it("records collection failure and partial usage without inventing zero totals", () => {
    const input = {
      episodeKey: tag,
      attempts,
      coordinatorThreadId: "maintenance",
      collectedAt: at(20),
    };
    expect(
      collectCheckpointEpisode(input, () => {
        throw new Error("database unavailable");
      }).effort,
    ).toMatchObject({ status: "missing", reason: "source-unavailable" });
    const partial = collectCheckpointEpisode(input, () => ({
      ...source,
      turns: [
        ...source.turns,
        { id: "turn-3", threadId: "child", runId: "run-2", startedAt: at(8), usage: null },
      ],
    }));
    expect(partial.effort).toMatchObject({
      status: "partial",
      agentTurns: 3,
      missingUsageTurnIds: ["turn-3"],
      inputTokens: 140,
    });
  });

  it("appends complete snapshots after a torn line and keeps old records readable", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-effort-"));
    try {
      const directory = NodePath.join(home, ".lastcode", "automation");
      NodeFS.mkdirSync(directory, { recursive: true });
      const path = NodePath.join(directory, "checkpoint-runs.jsonl");
      NodeFS.writeFileSync(path, `${attempts.map(JSON.stringify).join("\n")}\n{"partial"`);
      const records = recordCheckpointEpisodes({
        home,
        collectedAt: at(20),
        coordinatorThreadId: "maintenance",
        readSource: () => source,
      });
      expect(records).toHaveLength(1);
      expect(readJsonLines(path)).toHaveLength(3);
      expect(readLatestCheckpointRun(path)).toMatchObject({ status: "success", upstreamTag: tag });
      expect(readJsonLines(path)[2]).toMatchObject({
        status: "episode",
        episodeKey: tag,
        effort: { agentTurns: 2 },
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

it("aggregates large wholly synthetic counters across parent and child turns", () => {
  const turns = Array.from({ length: 7 }, (_, index) => ({
    id: `synthetic-turn-${index}`,
    threadId: index < 4 ? "maintenance" : "child",
    runId: `run-${index}`,
    startedAt: at(3),
    completedAt: at(9),
    usage: {
      inputTokens: 1000000000 + index,
      cachedInputTokens: 800000000,
      outputTokens: 200000 + index,
    },
  }));
  const result = collectCheckpointEpisode(
    {
      episodeKey: tag,
      coordinatorThreadId: "maintenance",
      collectedAt: at(20),
      attempts: Array.from({ length: 4 }, (_, index) => ({
        ...attempts[index === 3 ? 1 : 0],
        attemptOrdinal: index + 1,
      })),
    },
    () => ({ ...source, turns }),
  );
  expect(result.effort).toMatchObject({
    status: "complete",
    agentTurns: 7,
    inputTokens: 7000000021,
    cachedInputTokens: 5600000000,
    outputTokens: 1400021,
  });
  expect(result.attempts).toHaveLength(4);
});

it("records build readiness and a missing collector source without affecting build success", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-ready-"));
  try {
    const path = NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl");
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, attempts.map((attempt) => JSON.stringify(attempt)).join("\n"));
    recordInstallableBuildReady(
      { upstreamTag: tag, checkpointTag: `lastcode/checkpoint/${tag}`, builtAt: at(18) },
      {
        home,
        coordinatorThreadId: "maintenance",
        collectedAt: at(20),
        readSource: () => {
          throw new Error("unavailable");
        },
      },
    );
    const rows = readJsonLines(path);
    expect(rows.at(-2)).toMatchObject({ status: "build-ready", readyAt: at(18) });
    expect(rows.at(-1)).toMatchObject({
      status: "episode",
      effort: { status: "missing" },
      timing: { installableBuildReadyAt: at(18), revisionNeeded: false },
    });
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("reopens a completed episode for a later revision instead of freezing its first build", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-revision-effort-"));
  try {
    const directory = NodePath.join(home, ".lastcode", "automation");
    NodeFS.mkdirSync(directory, { recursive: true });
    const path = NodePath.join(directory, "checkpoint-runs.jsonl");
    NodeFS.writeFileSync(path, attempts.map((attempt) => JSON.stringify(attempt)).join("\n"));
    const options = {
      home,
      coordinatorThreadId: "maintenance",
      collectedAt: at(20),
      readSource: () => source,
    };
    recordInstallableBuildReady(
      { upstreamTag: tag, checkpointTag: `lastcode/checkpoint/${tag}`, builtAt: at(18) },
      options,
    );
    expect(recordCheckpointEpisodes(options)).toEqual([]);
    const revision = {
      ...attempts[1],
      startedAt: at(21),
      finishedAt: at(22),
      checkpointTag: `lastcode/revision/${tag}.1`,
    };
    NodeFS.writeFileSync(
      NodePath.join(directory, "checkpoint-revision-runs.jsonl"),
      JSON.stringify(revision),
    );
    const [reopened] = recordCheckpointEpisodes({ ...options, collectedAt: at(24) });
    expect(reopened.timing).toMatchObject({ revisionNeeded: true, installableBuildReadyAt: null });
    expect(reopened.attempts).toHaveLength(3);
    recordInstallableBuildReady(
      { upstreamTag: tag, checkpointTag: revision.checkpointTag, builtAt: at(25) },
      { ...options, collectedAt: at(26) },
    );
    expect(readJsonLines(path).at(-1).timing).toMatchObject({
      revisionNeeded: true,
      installableBuildReadyAt: at(25),
    });
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("marks incomplete timing sources, separates provider ledger usage and caps effort at the next nightly", () => {
  const result = collectCheckpointEpisode(
    {
      episodeKey: tag,
      attempts,
      coordinatorThreadId: "maintenance",
      collectedAt: at(30),
      finishedAt: at(15),
      build: { checkpointTag: `lastcode/checkpoint/${tag}`, readyAt: at(25) },
    },
    (window) => {
      expect(window.finishedAt).toBe(at(15));
      return {
        ...source,
        coverageMissing: ["remote-child:task"],
        turns: [
          {
            ...source.turns[0],
            usage: { ...source.turns[0].usage, otherUsage: { inputTokens: 50, outputTokens: 5 } },
          },
        ],
      };
    },
  );
  expect(result.timing.coverageMissing).toEqual(["remote-child:task"]);
  expect(result.timing.installableBuildReadyAt).toBe(at(25));
  expect(result.effort).toMatchObject({
    status: "partial",
    inputTokens: 100,
    otherInputTokens: 50,
    otherOutputTokens: 5,
  });
});

it("refreshes late alert delivery and authorization answers but does not append unchanged snapshots", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-late-timing-"));
  try {
    const directory = NodePath.join(home, ".lastcode", "automation");
    NodeFS.mkdirSync(directory, { recursive: true });
    const path = NodePath.join(directory, "checkpoint-runs.jsonl");
    NodeFS.writeFileSync(path, attempts.map((attempt) => JSON.stringify(attempt)).join("\n"));
    const incident = {
      openedAt: at(1),
      alertDelivery: "unknown",
      failure: { checkpointRun: attempts[0] },
    };
    const options = {
      home,
      coordinatorThreadId: "maintenance",
      collectedAt: at(20),
      state: { incident },
      readSource: () => ({
        ...source,
        requests: [{ ...source.requests[0], status: "pending", resolvedAt: null }],
      }),
    };
    recordInstallableBuildReady(
      { upstreamTag: tag, checkpointTag: `lastcode/checkpoint/${tag}`, builtAt: at(18) },
      options,
    );
    const [updated] = recordCheckpointEpisodes({
      ...options,
      collectedAt: at(21),
      state: { incident: { ...incident, alertDelivery: "sent", alertDeliveredAt: at(21) } },
      readSource: () => source,
    });
    expect(updated.alerts[0].status).toBe("sent");
    expect(updated.timing.authorizations[0].status).toBe("resolved");
    const stable = {
      ...options,
      collectedAt: at(22),
      state: { incident: { ...incident, alertDelivery: "sent", alertDeliveredAt: at(21) } },
      readSource: () => source,
    };
    expect(recordCheckpointEpisodes(stable)).toEqual([]);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("attributes a late revision to separate windows and keeps the first qualifying build", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-late-revision-"));
  try {
    const directory = NodePath.join(home, ".lastcode", "automation");
    NodeFS.mkdirSync(directory, { recursive: true });
    const history = NodePath.join(directory, "checkpoint-runs.jsonl");
    const next = {
      ...attempts[1],
      upstreamTag: "next-nightly",
      checkpointTag: "lastcode/checkpoint/next-nightly",
      startedAt: at(15),
      finishedAt: at(17),
    };
    const revision = {
      ...attempts[1],
      checkpointTag: `lastcode/revision/${tag}.1`,
      startedAt: at(21),
      finishedAt: at(24),
    };
    const builds = [14, 23, 24, 25, 29].map((minute) => ({
      schemaVersion: 1,
      status: "build-ready",
      episodeKey: tag,
      checkpointTag:
        minute === 14 || minute === 24 ? `lastcode/checkpoint/${tag}` : revision.checkpointTag,
      readyAt: at(minute),
    }));
    NodeFS.writeFileSync(
      history,
      [...attempts, next, ...builds].map((row) => JSON.stringify(row)).join("\n"),
    );
    NodeFS.writeFileSync(
      NodePath.join(directory, "checkpoint-revision-runs.jsonl"),
      JSON.stringify(revision),
    );
    const turns = [
      source.turns[0],
      {
        ...source.turns[0],
        id: "next-turn",
        startedAt: at(16),
        completedAt: at(17),
        usage: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 3 },
      },
      {
        ...source.turns[0],
        id: "revision-turn",
        startedAt: at(23),
        completedAt: at(24),
        usage: { inputTokens: 45, cachedInputTokens: 30, outputTokens: 4 },
      },
    ];
    const rows = recordCheckpointEpisodes({
      home,
      collectedAt: at(30),
      coordinatorThreadId: "maintenance",
      readSource: ({ startedAt, finishedAt }) => ({
        ...source,
        turns: turns.filter((turn) => turn.startedAt >= startedAt && turn.startedAt < finishedAt),
        requests: [
          ...source.requests,
          {
            ...source.requests[0],
            id: "revision-authorization",
            createdAt: at(23),
            resolvedAt: at(24),
          },
        ].filter((row) => row.createdAt >= startedAt && row.createdAt < finishedAt),
        ownerMessages: [
          ...source.ownerMessages,
          { id: "revision-owner", threadId: "maintenance", createdAt: at(23) },
        ].filter((row) => row.createdAt >= startedAt && row.createdAt < finishedAt),
      }),
    });
    expect(rows.map((row) => row.episodeKey)).toEqual([tag, "next-nightly"]);
    const older = rows.find((row) => row.episodeKey === tag);
    expect(older.windows).toEqual([
      { startedAt: at(0), finishedAt: at(14) },
      { startedAt: at(21), finishedAt: at(25) },
    ]);
    expect(older.effort).toMatchObject({ status: "complete", agentTurns: 2, inputTokens: 145 });
    expect(older.timing).toMatchObject({
      installableBuildReadyAt: at(25),
      revisionNeeded: true,
      ownerInterruptions: 2,
    });
    expect(older.timing.authorizations.map((row) => row.id)).toContain("revision-authorization");
    expect(rows.find((row) => row.episodeKey === "next-nightly").effort.inputTokens).toBe(30);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
