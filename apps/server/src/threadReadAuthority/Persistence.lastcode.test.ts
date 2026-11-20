import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrateDevDb } from "../../scripts/migrate-dev-db.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { runDatabaseMigrations } from "../persistence/DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../persistence/LastCodeMigrations.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { authorityTables, verifyAuthorityFence } from "./Schema.ts";
import * as Store from "./Store.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "authority persistence seams",
  (it) => {
    it.effect(
      "takes migration ownership before repairing a lost fence with both ledgers current",
      () =>
        Effect.gen(function* () {
          const { dbPath, serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
          const database = NodeSqliteClient.layer({ filename: dbPath });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runDatabaseMigrations();
            yield* sql`DROP TRIGGER lastcode_thread_read_device_delete`;
          }).pipe(Effect.provide(database));
          const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
          yield* ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
            Effect.provide(ProcessRunner.layer),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, {}),
          );
          const opened = yield* Effect.void.pipe(
            Effect.provide(Sqlite.layerCliConfig),
            Effect.result,
          );
          assert.equal(opened._tag, "Failure");
          if (opened._tag === "Failure")
            assert.instanceOf(opened.failure, Sqlite.ServerOwnsDatabaseError);
          assert.isFalse(yield* verifyAuthorityFence().pipe(Effect.provide(database)));
        }).pipe(
          Effect.scoped,
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "authority-cli-" })),
        ),
    );

    it.effect(
      "clears device approval and every private authority table through the real dev snapshot command",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const sharedHome = path.join(directory, "source");
          const source = path.join(sharedHome, "userdata", "statev2.sqlite");
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runDatabaseMigrations();
            yield* sql`INSERT INTO auth_connect_devices (proof_key_thumbprint, approved_at) VALUES ('key', '1970-01-01T00:00:00.000Z')`;
            yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at, proof_key_thumbprint)
          VALUES ('session', 'cloud-connect', '["orchestration:read"]', 'dpop-access-token', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'key')`;
            const store = yield* Store.make;
            const authority = (yield* store.captureAuthenticatedSessionAuthority("session"))!;
            yield* store.bindGrant(ThreadId.make("source-thread"), "run", "run", authority, 0);
            yield* store.recordFailure(
              ThreadId.make("source-thread"),
              "run",
              "denied",
              "reauth-required",
              0,
            );
            yield* sql`INSERT INTO lastcode_thread_read_handoffs(source_session_id, target_session_id, family_id, proof_key)
          VALUES ('prior', 'session', ${authority.familyId}, 'key')`;
            yield* sql`INSERT INTO lastcode_thread_read_handoff_exceptions(source_session_id, target_session_id) VALUES ('pending', 'session')`;
            for (const table of authorityTables)
              assert.isAbove(
                (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`)[0]!.n,
                0,
              );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
          const result = yield* runMigrateDevDb(
            {
              source,
              baseDir: path.join(directory, "destination"),
              projects: 1,
              threadsPerProject: 1,
            },
            { sharedHome },
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const table of ["auth_sessions", "auth_connect_devices", ...authorityTables]) {
              assert.deepEqual(yield* sql`SELECT * FROM ${sql(table)}`, []);
            }
            assert.isTrue(yield* verifyAuthorityFence());
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: result.databasePath })));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal(
              (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM auth_sessions`)[0]!.n,
              1,
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
        }).pipe(Effect.scoped),
    );

    it.effect(
      "initializes existing session snapshots once at first feature migration and never backfills a lost snapshot",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();
          yield* runLastCodeMigrations({ toMigrationInclusive: 20 });
          yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('existing', 'paired', '["orchestration:read"]', 'browser-session-cookie', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;
          assert.deepEqual(yield* runDatabaseMigrations(), [
            [21, "ThreadReadAuthority"],
            [22, "ProjectRegistration"],
            [23, "OrchestrationV2ArchiveRecordedOwnerIndexes"],
            [24, "LastCodeArchiveJournal"],
          ]);
          const store = yield* Store.make;
          assert.isDefined(yield* store.captureAuthenticatedSessionAuthority("existing"));
          assert.deepEqual(yield* sql`SELECT * FROM lastcode_thread_read_grants`, []);
          yield* sql`DELETE FROM lastcode_thread_read_sessions WHERE session_id = 'existing'`;
          assert.deepEqual(yield* runDatabaseMigrations(), []);
          assert.isUndefined(yield* store.captureAuthenticatedSessionAuthority("existing"));
          assert.equal(yield* store.sessionAuthorityStatus("existing"), "reauth-required");
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  },
);
