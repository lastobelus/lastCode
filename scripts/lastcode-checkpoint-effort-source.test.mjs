import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { readEpisodeSource } from "./lastcode-checkpoint-effort-source.mjs";

const at = (minute) => new Date(Date.UTC(2026, 7, 26, 0, minute)).toISOString();
const complete = (inputTokens, outputTokens, cachedInputTokens) => ({
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens,
  outputTokens,
  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
});

function withFixture(test) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "checkpoint-effort-source-"));
  const databasePath = NodePath.join(directory, "fixture.sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, child_thread_id TEXT,
      provider_thread_id TEXT, origin TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, provider_thread_id TEXT,
      run_attempt_id TEXT, node_id TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, run_id TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (
      runtime_request_id TEXT PRIMARY KEY, thread_id TEXT, kind TEXT,
      created_at TEXT, resolved_at TEXT, status TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT
    );
  `);
  const insert = (table, row) =>
    database
      .prepare(
        `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(row));
  const thread = (id, lineage = {}) =>
    insert("orchestration_v2_projection_threads", {
      thread_id: id,
      payload_json: JSON.stringify({ lineage }),
    });
  const task = (id, parent, child, overrides = {}, payload = {}) =>
    insert("orchestration_v2_projection_subagents", {
      subagent_id: id,
      thread_id: parent,
      run_id: `run-${parent}`,
      child_thread_id: child,
      provider_thread_id: child === null ? null : `provider-${child}`,
      origin: "app_owned",
      started_at: at(2),
      completed_at: at(8),
      payload_json: JSON.stringify(payload),
      ...overrides,
    });
  const turn = (id, threadId, usage, overrides = {}, payload = {}) => {
    const native = overrides.run_attempt_id === null;
    insert("orchestration_v2_projection_nodes", {
      node_id: `node-${id}`,
      run_id: `run-${threadId}`,
    });
    if (!native)
      insert("orchestration_v2_projection_run_attempts", {
        attempt_id: `attempt-${id}`,
        run_id: `run-${threadId}`,
      });
    insert("orchestration_v2_projection_provider_turns", {
      provider_turn_id: id,
      thread_id: threadId,
      provider_thread_id: `provider-${threadId}`,
      run_attempt_id: native ? null : `attempt-${id}`,
      node_id: `node-${id}`,
      started_at: at(3),
      completed_at: at(5),
      payload_json: JSON.stringify({
        ...(usage === undefined ? {} : { turnTokenUsage: usage }),
        ...payload,
      }),
      ...overrides,
    });
  };
  const read = () =>
    readEpisodeSource({
      databasePath,
      coordinatorThreadId: "parent",
      startedAt: at(1),
      finishedAt: at(10),
    });
  thread("parent");
  try {
    test({ database, databasePath, thread, task, turn, insert, read });
  } finally {
    database.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

describe("checkpoint episode projection source", () => {
  it("counts parent, recursive local children and native turns exactly once without using context snapshots", () => {
    withFixture(({ databasePath, thread, task, turn, read }) => {
      for (const [id, parent] of [
        ["child", "parent"],
        ["grandchild", "child"],
        ["native", "parent"],
      ]) {
        thread(id, { parentThreadId: parent, relationshipToParent: "subagent" });
        task(`task-${id}`, parent, id, {
          origin: id === "native" ? "provider_native" : "app_owned",
        });
      }
      turn("turn-parent", "parent", { ...complete(100, 10, 80), hasSubagents: true });
      turn("turn-child", "child", complete(40, 5, 20));
      turn(
        "turn-grandchild",
        "grandchild",
        undefined,
        {},
        { tokenUsage: { usedTokens: 9000, inputTokens: 8000, outputTokens: 1000 } },
      );
      turn("turn-native", "native", complete(15, 1, 5), { run_attempt_id: null });
      turn("turn-before", "parent", complete(9000, 9000), {
        started_at: at(-1),
        completed_at: at(1),
      });
      turn("turn-after", "parent", complete(9000, 9000), {
        started_at: at(10),
        completed_at: at(11),
      });
      const before = NodeFS.readFileSync(databasePath);
      const source = read();
      expect(source.threadIds.toSorted()).toEqual(["child", "grandchild", "native", "parent"]);
      expect(source.turns).toHaveLength(4);
      expect(source.turns.find((row) => row.id === "turn-native").runId).toBe("run-native");
      expect(source.turns.find((row) => row.id === "turn-grandchild").usage).toBeNull();
      expect(
        source.turns.reduce(
          (sum, row) => ({
            input: sum.input + (row.usage?.inputTokens ?? 0),
            cached: sum.cached + (row.usage?.cachedInputTokens ?? 0),
            output: sum.output + (row.usage?.outputTokens ?? 0),
          }),
          { input: 0, cached: 0, output: 0 },
        ),
      ).toEqual({ input: 155, cached: 105, output: 16 });
      expect(source.coverageMissing).toEqual(["turn-usage-unavailable:turn-grandchild"]);
      expect(NodeFS.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("excludes independent, released, old and forked children and flags remote or unrepresented native work", () => {
    withFixture(({ thread, task, turn, read }) => {
      thread("orphan", { parentThreadId: "parent", relationshipToParent: "subagent" });
      turn("turn-orphan", "orphan", complete(9000, 9000), {
        started_at: at(-5),
        completed_at: at(0),
      });
      for (const id of ["independent", "released", "old", "fork"]) {
        thread(id, {
          parentThreadId: "parent",
          relationshipToParent: id === "fork" ? "fork" : "subagent",
          independent: id === "independent",
        });
        turn(`turn-${id}`, id, complete(9000, 9000));
      }
      task("task-independent", "parent", "independent");
      task("task-released", "parent", "released", {}, { ownershipReleased: true });
      task("task-old", "parent", "old", { started_at: at(-5), completed_at: at(0) });
      task(
        "task-remote",
        "parent",
        null,
        {},
        { remoteChild: { environmentId: "remote-environment", threadId: "remote-thread" } },
      );
      task("task-native", "parent", null, {
        origin: "provider_native",
        provider_thread_id: "provider-unrepresented",
      });
      turn("turn-parent", "parent", {
        ...complete(100, 10),
        otherUsage: { inputTokens: 50, outputTokens: 5 },
      });
      expect(read().turns[0].usage.otherUsage).toEqual({ inputTokens: 50, outputTokens: 5 });
      expect(read()).toMatchObject({
        threadIds: ["parent"],
        turns: [{ id: "turn-parent", usage: { inputTokens: 100, outputTokens: 10 } }],
        coverageMissing: [
          "child-ownership-unavailable:task-independent",
          "native-subagent-unrepresented:task-native",
          "released-child-history-unavailable:task-released",
          "remote-child:task-remote",
          "unattributed-other-usage:turn-parent",
        ],
      });
    });
  });

  it("retains overlapping turns and request answers while distinguishing UI owner messages from automation", () => {
    withFixture(({ insert, turn, read }) => {
      turn("overlap", "parent", complete(10, 2), { started_at: at(0), completed_at: at(2) });
      for (const [id, createdAt, resolvedAt, status] of [
        ["answered", at(0), at(1), "resolved"],
        ["pending", at(0), null, "pending"],
        ["before", at(-2), at(0), "resolved"],
        ["after", at(10), null, "pending"],
      ]) {
        insert("orchestration_v2_projection_runtime_requests", {
          runtime_request_id: id,
          thread_id: "parent",
          kind: "command",
          created_at: createdAt,
          resolved_at: resolvedAt,
          status,
          payload_json: JSON.stringify(id === "answered" ? { decision: "decline" } : {}),
        });
      }
      for (const [id, source, createdBy, createdAt] of [
        ["web-owner", "web", "user", at(1)],
        ["mobile-owner", "mobile", "user", at(9)],
        ["automation", "server", "user", at(3)],
        ["agent", "mcp", "agent", at(3)],
        ["owner-after", "web", "user", at(10)],
      ]) {
        insert("orchestration_v2_projection_messages", {
          message_id: id,
          thread_id: "parent",
          role: "user",
          created_at: createdAt,
          payload_json: JSON.stringify({ createdBy, creationSource: source }),
        });
      }
      const source = read();
      expect(source.turns.map((row) => row.id)).toEqual(["overlap"]);
      expect(source.requests).toEqual([
        {
          id: "answered",
          threadId: "parent",
          kind: "command",
          createdAt: at(0),
          resolvedAt: at(1),
          status: "resolved",
          decision: "decline",
        },
        {
          id: "pending",
          threadId: "parent",
          kind: "command",
          createdAt: at(0),
          resolvedAt: null,
          status: "pending",
        },
      ]);
      expect(source.ownerMessages).toEqual([
        { id: "web-owner", threadId: "parent", createdAt: at(1) },
        { id: "mobile-owner", threadId: "parent", createdAt: at(9) },
      ]);
      expect(source.coverageMissing).toEqual(["owner-message-attribution:automation"]);
    });
  });

  it("flags partial, absent and invalid counts, unknown run attribution and native work without task records", () => {
    withFixture(({ database, turn, read }) => {
      turn("partial", "parent", { ...complete(12, 2), usageStatus: "partial" });
      turn("missing-output", "parent", { usageStatus: "complete", inputTokens: 12 });
      turn("invalid-cache", "parent", complete(12, 2, 13));
      turn(
        "native-unknown",
        "parent",
        { ...complete(12, 2), hasSubagents: true },
        { run_attempt_id: null, started_at: null },
      );
      database
        .prepare("DELETE FROM orchestration_v2_projection_nodes WHERE node_id = ?")
        .run("node-native-unknown");
      const source = read();
      expect(source.turns.filter((row) => row.usage === null)).toHaveLength(3);
      expect(source.turns.find((row) => row.id === "native-unknown").usage).toEqual({
        inputTokens: 12,
        outputTokens: 2,
      });
      expect(source.coverageMissing).toEqual([
        "native-subagent-unrepresented:native-unknown",
        "turn-run-unavailable:native-unknown",
        "turn-start-unavailable:native-unknown",
        "turn-usage-unavailable:invalid-cache",
        "turn-usage-unavailable:missing-output",
        "turn-usage-unavailable:partial",
      ]);
    });
  });

  it("reports inaccessible or incompatible sources without creating or migrating a database", () => {
    withFixture(({ database, databasePath, read }) => {
      const absent = NodePath.join(NodePath.dirname(databasePath), "absent.sqlite");
      expect(
        readEpisodeSource({
          databasePath: absent,
          coordinatorThreadId: "parent",
          startedAt: at(1),
          finishedAt: at(10),
        }).coverageMissing,
      ).toEqual(["database-unavailable"]);
      expect(NodeFS.existsSync(absent)).toBe(false);
      database.exec("DROP TABLE orchestration_v2_projection_provider_turns");
      const before = NodeFS.readFileSync(databasePath);
      expect(read().coverageMissing).toEqual(["projection-unavailable"]);
      expect(NodeFS.readFileSync(databasePath)).toEqual(before);
    });
  });
});
