import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { DatabaseSchemaMismatchError, runDatabaseMigrations } from "./DatabaseMigrations.ts";
import { lastcodeMigrationManifest } from "./LastCodeMigrations.ts";
import * as SqliteWithoutMigrations from "./SqliteWithoutMigrations.ts";

it.effect("opens a server's database without creating or migrating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-verified-" });
    const filename = path.join(directory, "state #1.sqlite");
    const open = Effect.void.pipe(Effect.provide(SqliteWithoutMigrations.layerFromPath(filename)));
    assert.instanceOf(yield* Effect.flip(open), DatabaseSchemaMismatchError);
    assert.isFalse(yield* fs.exists(filename));

    yield* runDatabaseMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    yield* open;

    const [lastId] = lastcodeMigrationManifest.at(-1)!;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM lastcode_sql_migrations WHERE migration_id = ${lastId}`;
      assert.instanceOf(yield* Effect.flip(open), DatabaseSchemaMismatchError);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM lastcode_sql_migrations WHERE migration_id = ${lastId}`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
