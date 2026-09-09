import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runDatabaseMigrations } from "./DatabaseMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import { legacyUpstreamMigrationEntries } from "./LegacyUpstreamMigrations.ts";
import { lastcodeMigrationEntries, lastcodeMigrationManifest } from "./LastCodeMigrations.ts";
import { legacyMigrationHistories } from "./LegacyMigrationHistories.ts";
import projectIconMigration from "./Migrations/047_ProjectionProjectIcon.ts";

it("keeps the legacy replay identities aligned with the public upstream manifest", () => {
  assert.deepStrictEqual(
    legacyUpstreamMigrationEntries.map(([id, name]) => [id, name]),
    migrationManifest.filter(([id]) => id <= 49).map(([id, name]) => [id, name]),
  );
});

// These fixtures contain only public migration identities and invented data.
// Running only new numeric suffixes reproduces Effect's historical behavior.
const seedHistory = Effect.fn("seedHistory")(function* (
  entries: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 41 });
  const applied = new Set<string>();
  for (const [id, name] of entries) {
    const migration = [...legacyUpstreamMigrationEntries, ...lastcodeMigrationEntries].find(
      (entry) => entry[1] === name,
    )?.[2];
    if (migration && !applied.has(name)) yield* migration;
    if (name === "RepairMigration57ProjectionColumns") {
      yield* projectIconMigration;
      yield* lastcodeMigrationEntries[9][2];
    }
    applied.add(name);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (${id}, ${name}, '2026-01-01 00:00:00')`;
  }
});

const assertCurrent = Effect.fn("assertCurrent")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, manifest] of [
    ["effect_sql_migrations", migrationManifest],
    ["lastcode_sql_migrations", lastcodeMigrationManifest],
  ] as const) {
    const rows = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id`;
    assert.deepStrictEqual(
      rows.map((row) => [row.migration_id, row.name]),
      manifest.map(([id, name]) => [id, name]),
    );
  }
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  for (const name of [
    "annotation_json",
    "attention_json",
    "branch_pull_request_json",
    "active_order_key",
    "persistent",
    "linked_pull_request_json",
    "unsettled_at",
  ]) {
    assert.ok(
      columns.some((column) => column.name === name),
      name,
    );
  }
  const projects = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  assert.ok(projects.some((column) => column.name === "project_icon_json"));
});

for (const history of legacyMigrationHistories) {
  it.layer(NodeSqliteClient.layerMemory())(history.source, (it) => {
    it.effect(
      "converts the released history, archives it exactly, and is stable on repeat startup",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedHistory(history.entries);
          const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, latest_user_message_id)
        VALUES ('thread-1', 'project-1', 'Existing thread', '{"instanceId":"codex","model":"example-model"}', 'full-access', '2026-01-01', '2026-01-02', 'keep-existing-message')`;
          yield* runDatabaseMigrations();
          yield* assertCurrent();
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM lastcode_legacy_sql_migrations ORDER BY migration_id`,
            before,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT title, latest_user_message_id FROM projection_threads`,
            [{ title: "Existing thread", latest_user_message_id: "keep-existing-message" }],
          );
          assert.deepStrictEqual(yield* runDatabaseMigrations(), []);
        }),
    );
  });
}

it.layer(NodeSqliteClient.layerMemory())("fresh database", (it) => {
  it.effect("creates independent ledgers without a legacy archive", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runDatabaseMigrations();
      yield* assertCurrent();
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'lastcode_legacy_sql_migrations'`,
        [],
      );
      assert.deepStrictEqual(yield* runDatabaseMigrations(), []);
    }),
  );
});

for (const through of [41, 49]) {
  it.layer(NodeSqliteClient.layerMemory())(`upstream through ${through}`, (it) => {
    it.effect("upgrades an upstream-only database", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: through });
        yield* runDatabaseMigrations();
        yield* assertCurrent();
      }),
    );
  });
}

it.layer(NodeSqliteClient.layerMemory())("mixed repaired history", (it) => {
  it.effect(
    "repairs missing branch PR after old project-icon 57, repair 58 and active-order 59",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const old = legacyMigrationHistories.find((history) =>
          history.entries.some(([id, name]) => id === 57 && name === "ProjectionProjectIcon"),
        )!;
        yield* seedHistory([
          ...old.entries,
          [58, "RepairMigration57ProjectionColumns"],
          [59, "ProjectionThreadsActiveOrderKey"],
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_table_info('projection_threads') WHERE name = 'branch_pull_request_json'`,
          [],
        );
        yield* runDatabaseMigrations();
        yield* assertCurrent();
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM lastcode_legacy_sql_migrations WHERE migration_id = 58`,
          [{ name: "RepairMigration57ProjectionColumns" }],
        );
      }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("unknown history", (it) => {
  it.effect("leaves every table and ledger unchanged on an unknown identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory(legacyMigrationHistories[0].entries);
      yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownMigration' WHERE migration_id = 42`;
      const before = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runDatabaseMigrations())));
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, before);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("conversion rollback", (it) => {
  it.effect(
    "rolls back the archive, replacement ledgers and earlier repairs when later migration SQL fails",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedHistory(legacyMigrationHistories[0].entries);
        yield* sql`DROP TABLE projection_projects`;
        const before = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runDatabaseMigrations())));
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, before);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          ledger,
        );
      }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("recorded data transformations", (it) => {
  it.effect("preserves model defaults and settlement values written after their migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const history = legacyMigrationHistories.find((entry) =>
        entry.entries.some(([id, name]) => id === 57 && name === "ProjectionProjectIcon"),
      )!;
      yield* seedHistory(history.entries);
      const selection = '{"instanceId":"codex","model":"example-model"}';
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
      VALUES ('project-1', 'Example project', '/example/project', ${selection}, '[]', '2026-01-01', '2026-01-02')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, settled_override, settled_at)
      VALUES ('thread-1', 'project-1', 'Example thread', ${selection}, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'settled', '2026-01-02T00:00:00.000Z')`;
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, correlation_id, actor_kind, payload_json, metadata_json)
      VALUES ('event-project', 'project', 'project-1', 0, 'project.created', '2026-01-01T00:00:00.000Z', 'command-project', 'command-project', 'client', '{"defaultModelSelection":{"instanceId":"codex","model":"example-model"}}', '{}'),
      ('event-settlement', 'thread', 'thread-1', 0, 'thread.settled', '2026-01-02T00:00:00.000Z', 'server:auto-settle:example', 'command-settlement', 'server', '{"settledAt":"2026-01-02T00:00:00.000Z"}', '{}')`;
      const before = yield* sql`SELECT * FROM orchestration_events ORDER BY event_id`;
      yield* runDatabaseMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT default_model_selection_json FROM projection_projects`,
        [{ default_model_selection_json: selection }],
      );
      assert.deepStrictEqual(yield* sql`SELECT settled_at FROM projection_threads`, [
        { settled_at: "2026-01-02T00:00:00.000Z" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY event_id`,
        before,
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("crossed released registries", (it) => {
  it.effect("recognizes a ledger assembled by numeric-suffix upgrades across three releases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const original = legacyMigrationHistories.find((entry) => entry.entries.at(-1)?.[0] === 46)!;
      const middle = legacyMigrationHistories.find((entry) => entry.entries.at(-1)?.[0] === 52)!;
      const latest = legacyMigrationHistories.find((entry) => entry.entries.at(-1)?.[0] === 59)!;
      yield* seedHistory([
        ...original.entries,
        ...middle.entries.filter(([id]) => id > 46),
        ...latest.entries.filter(([id]) => id > 52),
      ]);
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* runDatabaseMigrations();
      yield* assertCurrent();
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM lastcode_legacy_sql_migrations ORDER BY migration_id`,
        ledger,
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("incompatible schema", (it) => {
  it.effect("rejects an incompatible collided column without changing the legacy ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory(legacyMigrationHistories[0].entries);
      yield* sql`ALTER TABLE projection_threads ADD COLUMN attention_json INTEGER`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runDatabaseMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'lastcode_legacy_sql_migrations'`,
        [],
      );
    }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("missing LastCode ledger", (it) => {
  it.effect(
    "does not replay data transformations when downstream tables exist without history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runDatabaseMigrations();
        yield* sql`DROP TABLE lastcode_sql_migrations`;
        const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runDatabaseMigrations())));
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
      }),
  );
});
