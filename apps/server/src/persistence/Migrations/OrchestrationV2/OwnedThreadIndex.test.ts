import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";
import { interactiveThreadParentSql } from "../../../orchestration-v2/InteractiveThreadParentSql.ts";
import { archiveFamilyThreadIdsQuery } from "../../../orchestration-v2/ThreadArchiveReader.ts";

it.effect("upgrades existing v2 databases and indexes every step of owned-thread traversal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runLastCodeMigrations({ toMigrationInclusive: 12 });
    assert.deepEqual(yield* runDatabaseMigrations(), [
      [13, "OrchestrationV2OwnedThreadIndex"],
      [14, "OrchestrationV2GroupedCreatorThreadIndex"],
      [15, "OrchestrationV2ArchiveReadIndex"],
      [16, "OrchestrationV2CommandHistoryIndex"],
      [17, "OrchestrationV2ThreadReadAuthorizationIndex"],
      [18, "OrchestrationV2InteractiveThreadParentIndex"],
      [19, "OrchestrationV2PullRequestWatchIndex"],
      [20, "OrchestrationV2RetiredNativePromotion"],
      [21, "ThreadReadAuthority"],
      [22, "ProjectRegistration"],
      [23, "OrchestrationV2ArchiveRecordedOwnerIndexes"],
      [24, "LastCodeArchiveJournal"],
    ]);
    assert.deepEqual(yield* runDatabaseMigrations(), []);
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      WITH RECURSIVE family(thread_id) AS (
        SELECT 'root'
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN family ON CAST(json_extract(child.payload_json, '$.lineage.parentThreadId') AS TEXT) = family.thread_id
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      )
      SELECT thread_id FROM family
    `;
    assert.isTrue(
      plan.some((step) =>
        step.detail.includes(
          "SEARCH child USING INDEX orchestration_v2_projection_threads_owned_parent_idx",
        ),
      ),
    );
    assert.isFalse(plan.some((step) => /^SCAN child\b/.test(step.detail)));
    const [archiveSql, params] = archiveFamilyThreadIdsQuery(
      sql,
      ThreadId.make("example-root"),
    ).compile();
    const archivePlan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${archiveSql}`,
      params,
    );
    for (const index of [
      "owned_parent",
      "interactive_parent",
      "archive_creator_owner",
      "archive_delegated_owner",
    ])
      assert.equal(
        archivePlan.filter((step) =>
          step.detail.includes(
            `SEARCH child USING INDEX orchestration_v2_projection_threads_${index}_idx`,
          ),
        ).length,
        2,
        JSON.stringify(archivePlan),
      );
    // Only the restore branch may scan the thread table, after finding a root with a cohort.
    assert.lengthOf(
      archivePlan.filter((step) => /^SCAN child\b/.test(step.detail)),
      1,
    );
    const groupedPlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
      WHERE ${interactiveThreadParentSql(sql, "child")} IN ('example-root')
        AND child.deleted_at IS NULL
      ORDER BY child.thread_id
    `;
    assert.isTrue(
      groupedPlan.some((step) =>
        step.detail.includes(
          "SEARCH child USING INDEX orchestration_v2_projection_threads_interactive_parent_idx",
        ),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
