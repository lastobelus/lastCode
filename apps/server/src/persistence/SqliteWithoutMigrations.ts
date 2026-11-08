import * as NodeURL from "node:url";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { DatabaseSchemaMismatchError, verifyDatabaseMigrations } from "./DatabaseMigrations.ts";

export const layerFromPath = Effect.fn("SqliteWithoutMigrations.layerFromPath")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(dbPath))) {
    return yield* new DatabaseSchemaMismatchError({
      message: `No database exists at ${dbPath}. Start the server that owns it first.`,
    });
  }
  // Session writes need a writable connection. SQLite's rw mode refuses to create a file.
  const databaseUrl = NodeURL.pathToFileURL(dbPath);
  databaseUrl.searchParams.set("mode", "rw");
  return Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 5000;`;
        yield* sql`PRAGMA foreign_keys = ON;`;
        yield* verifyDatabaseMigrations();
      }),
    ),
    NodeSqliteClient.layer({ filename: databaseUrl.href }),
  );
}, Layer.unwrap);

export const layerConfig = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, ({ dbPath }) => layerFromPath(dbPath)),
);
