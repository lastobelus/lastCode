import { EnvironmentId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  HistoricalThreadCreatorRepairManifest,
  repairScopedHistoricalThreadCreators,
} from "../orchestration-v2/repairHistoricalThreadCreators.ts";
import { holdServerOwnershipLock } from "../serverOwnership.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(HistoricalThreadCreatorRepairManifest),
);
const decodeEnvironmentId = Schema.decodeEffect(EnvironmentId);
const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const repairThreadCreatorsCommand = Command.make("repair-thread-creators", {
  ...projectLocationFlags,
  manifest: Flag.String("manifest"),
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
}).pipe(
  Command.unlisted,
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* decodeManifest(yield* fs.readFileString(flags.manifest));
      const environmentId = yield* decodeEnvironmentId(
        (yield* fs.readFileString(config.environmentIdPath)).trim(),
      );
      yield* fs.stat(config.dbPath);
      if (flags.apply) yield* holdServerOwnershipLock(config.serverRuntimeStatePath);
      const result = yield* repairScopedHistoricalThreadCreators(
        manifest,
        environmentId,
        flags.apply,
      ).pipe(
        Effect.provide(
          EventSink.layer.pipe(
            Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(
              NodeSqliteClient.layer({ filename: config.dbPath, readonly: !flags.apply }),
            ),
          ),
        ),
      );
      yield* Console.log(yield* encodeOutput(result));
    }).pipe(Effect.scoped),
  ),
);
