import { EnvironmentId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  HistoricalThreadCreatorRepairManifest,
  isHistoricalThreadCreatorRepairError,
  repairScopedHistoricalThreadCreators,
} from "../orchestration-v2/repairHistoricalThreadCreators.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnerLease } from "../serverOwnerLease.ts";
import { acquireServerOwnership, ServerAlreadyRunningError } from "../serverOwnership.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveThreadInspectionConfig } from "./config.ts";

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(HistoricalThreadCreatorRepairManifest),
);
const decodeEnvironmentId = Schema.decodeEffect(EnvironmentId);
const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const repairThreadCreatorsCommand = Command.make("repair-thread-creators", {
  ...projectLocationFlags,
  stateDir: Flag.String("state-dir").pipe(Flag.optional),
  manifest: Flag.String("manifest"),
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
}).pipe(
  Command.unlisted,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveThreadInspectionConfig(flags, logLevel);
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* decodeManifest(yield* fs.readFileString(flags.manifest));
      const environmentId = yield* decodeEnvironmentId(
        (yield* fs.readFileString(config.environmentIdPath)).trim(),
      );
      yield* fs.stat(config.dbPath);
      if (flags.apply) {
        // Match server admission order. The database layer closes before this scope releases either lock.
        yield* Effect.acquireRelease(
          acquireServerOwnerLease(config.stateDir),
          (lease) => lease.release,
        );
        yield* acquireServerOwnership(config.serverRuntimeStatePath);
        const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
        if (Option.isSome(runtime) && isProcessAlive(runtime.value.pid)) {
          return yield* new ServerAlreadyRunningError({ stateDir: config.stateDir });
        }
      }
      const result = yield* Effect.gen(function* () {
        if (flags.apply) {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA busy_timeout = 5000`;
        }
        return yield* repairScopedHistoricalThreadCreators(manifest, environmentId, flags.apply);
      }).pipe(
        Effect.provide(
          EventSink.layer.pipe(
            Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(
              NodeSqliteClient.layer({ filename: config.dbPath, readonly: !flags.apply }),
            ),
          ),
        ),
        Effect.tapError((error) =>
          isHistoricalThreadCreatorRepairError(error) && error.failedThreadId !== undefined
            ? encodeOutput({ failedThreadId: error.failedThreadId, results: error.completed }).pipe(
                Effect.flatMap(Console.log),
              )
            : Effect.void,
        ),
      );
      yield* Console.log(yield* encodeOutput(result));
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer)),
  ),
);
