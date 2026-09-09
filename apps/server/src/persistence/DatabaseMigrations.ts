import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { legacyUpstreamMigrationEntries } from "./LegacyUpstreamMigrations.ts";
import {
  lastcodeMigrationEntries,
  lastcodeMigrationManifest,
  runLastCodeMigrations,
} from "./LastCodeMigrations.ts";
import { legacyMigrationHistories } from "./LegacyMigrationHistories.ts";

export class MigrationHistoryError extends Schema.TaggedError<MigrationHistoryError>()(
  "MigrationHistoryError",
  { message: Schema.String },
) {}

const invalid = (detail: string) =>
  new MigrationHistoryError({
    message: `Database migration history cannot be converted safely: ${detail}. Restore a database backup or contact support with the migration ledger and schema; do not delete migration records.`,
  });

type LedgerRow = {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
};

// These migrations change data, so a recorded identity must never be replayed.
const dataMigrations = new Set([
  "ClearAutomaticProjectModelDefaults",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionThreadAnnotation",
  "UpdateDrain",
  "UpdateDrainClaim",
  "ProjectionTurnRequestCorrelations",
]);

const verifyLedger = Effect.fn("verifyMigrationLedger")(function* (
  table: string,
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<LedgerRow>`SELECT migration_id, name, created_at FROM ${sql(table)} ORDER BY migration_id`;
  for (const [index, row] of rows.entries()) {
    if (manifest[index]?.[0] !== row.migration_id || manifest[index]?.[1] !== row.name) {
      return yield* invalid(
        `${table} contains an unknown or non-contiguous identity ${row.migration_id}_${row.name}`,
      );
    }
  }
  return rows;
});

const convertLegacyHistory = Effect.fn("convertLegacyMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
    sql: string;
  }>`SELECT name, sql FROM sqlite_master WHERE type = 'table'`;
  const hasTable = (name: string) => tables.some((table) => table.name === name);
  if (!hasTable("effect_sql_migrations")) {
    if (
      hasTable("lastcode_sql_migrations") ||
      hasTable("lastcode_legacy_sql_migrations") ||
      hasTable("projection_threads")
    ) {
      return yield* invalid("the upstream ledger is missing");
    }
    return;
  }
  if (hasTable("lastcode_sql_migrations")) {
    yield* verifyLedger("effect_sql_migrations", migrationManifest);
    yield* verifyLedger("lastcode_sql_migrations", lastcodeMigrationManifest);
    return;
  }
  if (hasTable("lastcode_legacy_sql_migrations")) {
    return yield* invalid("a legacy archive exists without the LastCode ledger");
  }
  const rows =
    yield* sql<LedgerRow>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
  const isUpstream = rows.every(
    (row, index) =>
      migrationManifest[index]?.[0] === row.migration_id &&
      migrationManifest[index]?.[1] === row.name,
  );
  if (isUpstream) {
    const downstreamColumns = yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('projection_threads')
      WHERE name IN ('annotation_json', 'latest_user_message_id', 'worktree_cleanup_json', 'persistent', 'attention_json')
      UNION ALL SELECT name FROM pragma_table_info('projection_thread_messages') WHERE name = 'source_thread_id'`;
    if (
      downstreamColumns.length > 0 ||
      hasTable("update_drain_events") ||
      hasTable("update_drain_command_receipts") ||
      hasTable("projection_turn_request_correlations") ||
      hasTable("projection_turn_assistant_finalizations")
    ) {
      return yield* invalid(
        "LastCode schema exists without its migration ledger or a recognized mixed history",
      );
    }
    return;
  }

  for (const [index, row] of rows.entries()) {
    const recognized =
      row.migration_id < 42
        ? migrationManifest[index]?.[1] === row.name
        : legacyMigrationHistories.some((history) =>
            history.entries.some(([id, name]) => id === row.migration_id && name === row.name),
          );
    if (row.migration_id !== index + 1 || !recognized) {
      return yield* invalid(`unrecognized identity ${row.migration_id}_${row.name}`);
    }
  }
  const completed = new Set(rows.map((row) => row.name));
  const columns = new Map<string, Set<string>>();
  for (const table of ["projection_threads", "projection_projects", "projection_thread_messages"]) {
    const info = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    columns.set(table, new Set(info.map((column) => column.name)));
  }
  for (const [table, expected] of [
    [
      "projection_threads",
      {
        annotation_json: "TEXT",
        latest_user_message_id: "TEXT",
        worktree_cleanup_json: "TEXT",
        linked_pull_request_json: "TEXT",
        unsettled_at: "TEXT",
        persistent: "INTEGER",
        attention_json: "TEXT",
        branch_pull_request_json: "TEXT",
        active_order_key: "TEXT",
      },
    ],
    ["projection_projects", { project_icon_json: "TEXT", auto_pull: "INTEGER" }],
    ["projection_thread_messages", { source_thread_id: "TEXT" }],
  ] as const) {
    const info = yield* sql<{
      name: string;
      type: string;
    }>`SELECT name, type FROM pragma_table_info(${table})`;
    for (const [column, type] of Object.entries(expected)) {
      const existing = info.find((entry) => entry.name === column);
      if (existing && existing.type.toUpperCase() !== type)
        return yield* invalid(`${table}.${column} has incompatible type ${existing.type}`);
    }
  }
  const hasColumn = (table: string, column: string) => columns.get(table)?.has(column) === true;
  if (completed.has("ProjectionThreadAnnotation")) {
    for (const column of ["annotation_json", "latest_user_message_id"]) {
      if (!hasColumn("projection_threads", column))
        return yield* invalid(`recorded annotation migration is missing ${column}`);
    }
  } else if (
    hasColumn("projection_threads", "annotation_json") ||
    hasColumn("projection_threads", "latest_user_message_id")
  ) {
    return yield* invalid("annotation columns exist without a recorded annotation migration");
  }
  for (const [name, required] of [
    ["UpdateDrain", ["update_drain_events", "update_drain_command_receipts"]],
    [
      "ProjectionTurnRequestCorrelations",
      ["projection_turn_request_correlations", "projection_turn_assistant_finalizations"],
    ],
  ] as const) {
    const present = required.filter(hasTable);
    if (
      (completed.has(name) && present.length !== required.length) ||
      (!completed.has(name) && present.length > 0)
    ) {
      return yield* invalid(`${name} tables disagree with the recorded history`);
    }
  }
  for (const [table, expected] of [
    [
      "update_drain_events",
      [
        "sequence",
        "event_id",
        "event_type",
        "command_id",
        "occurred_at",
        "request_id",
        "target_version",
        "status",
      ],
    ],
    [
      "update_drain_command_receipts",
      [
        "command_id",
        "command_type",
        "request_id",
        "target_version",
        "accepted_at",
        "result_sequence",
        "status",
        "error_reason",
        "error",
      ],
    ],
    [
      "projection_turn_request_correlations",
      ["thread_id", "message_id", "turn_id", "state", "requested_at", "resolved_at"],
    ],
    ["projection_turn_assistant_finalizations", ["thread_id", "turn_id", "finalized_at"]],
  ] as const) {
    if (!hasTable(table)) continue;
    const info = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    for (const column of expected) {
      if (!info.some((entry) => entry.name === column))
        return yield* invalid(`${table} is missing ${column}`);
    }
  }
  if (completed.has("UpdateDrainClaim") && !completed.has("UpdateDrain"))
    return yield* invalid("drain claim has no drain migration");
  if (completed.has("UpdateDrain")) {
    const claims = [
      ["update_drain_events", "update-drain.claimed"],
      ["update_drain_command_receipts", "update-drain.claim"],
    ] as const;
    for (const [table, claim] of claims) {
      const supportsClaim =
        tables.find((entry) => entry.name === table)?.sql.includes(`'${claim}'`) === true;
      if (supportsClaim !== completed.has("UpdateDrainClaim"))
        return yield* invalid(`${table} claim constraint disagrees with the ledger`);
    }
  }

  // The immutable archive is also the conversion marker. All repairs, both
  // replacement ledgers and this archive commit together in the outer transaction.
  yield* sql`ALTER TABLE effect_sql_migrations RENAME TO lastcode_legacy_sql_migrations`;
  for (const table of ["effect_sql_migrations", "lastcode_sql_migrations"]) {
    yield* sql`CREATE TABLE ${sql(table)} (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
  }
  for (const [table, entries] of [
    ["effect_sql_migrations", legacyUpstreamMigrationEntries],
    ["lastcode_sql_migrations", lastcodeMigrationEntries],
  ] as const) {
    for (const [id, name, migration] of entries) {
      // IDs 1..41 never collided. Schema-only migrations are idempotent and
      // reconcile the actual columns, including the repair-58/branch-PR collision.
      const old = rows.find((row) => row.name === name);
      if (!(table === "effect_sql_migrations" && id < 42) && !(old && dataMigrations.has(name))) {
        yield* migration;
      }
      yield* sql`INSERT INTO ${sql(table)} (migration_id, name, created_at) VALUES (${id}, ${name}, COALESCE(${old?.created_at ?? null}, current_timestamp))`;
    }
  }
});

/** Server and snapshot tools use this entrypoint; upstream keeps its own runner. */
export const runDatabaseMigrations = Effect.fn("runDatabaseMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* convertLegacyHistory();
      const upstream = yield* runMigrations();
      const lastcode = yield* runLastCodeMigrations();
      return [...upstream, ...lastcode];
    }),
  );
});
