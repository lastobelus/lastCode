import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { GlobalFlag } from "effect/cli";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import {
  ThreadServerNotRunningError,
  type ThreadTools,
  waitForRun,
  withThreadToolsWithoutMigrations,
} from "./threadMcp.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect("thread MCP leaves an older database untouched when the server has stopped", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-mcp-" });
    const stateDir = path.join(baseDir, "userdata");
    yield* fs.makeDirectory(stateDir);
    const filename = path.join(stateDir, "statev2.sqlite");
    const previousId = migrationManifest.at(-2)![0];
    yield* runMigrations({ toMigrationInclusive: previousId }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename })),
    );

    const result = yield* withThreadToolsWithoutMigrations(
      { baseDir: Option.some(baseDir), json: true },
      () => Effect.die("unexpected MCP session"),
    ).pipe(Effect.result);

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        latest: number;
      }>`SELECT MAX(migration_id) AS latest FROM effect_sql_migrations`;
      assert.strictEqual(rows[0]?.latest, previousId);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.instanceOf(result.failure, ThreadServerNotRunningError);
  }).pipe(
    Effect.scoped,
    Effect.provideService(GlobalFlag.LogLevel, Option.none()),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);
