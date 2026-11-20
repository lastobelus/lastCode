import { ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import { readProjectIcon } from "../assets/projectIcon.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveThreadInspectionConfig } from "./config.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const projectIconCommand = Command.make("icon", {
  ...projectLocationFlags,
  stateDir: Flag.String("state-dir").pipe(Flag.optional),
  projectId: Argument.String("project-id").pipe(Argument.withSchema(ProjectId)),
  json: Flag.Boolean("json"),
}).pipe(
  Command.withDescription("Resolved project icon as JSON"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveThreadInspectionConfig(flags, logLevel);
      const fs = yield* FileSystem.FileSystem;
      // Read-only: never create a state database for a lookup.
      const icon = (yield* fs.exists(config.dbPath))
        ? yield* readProjectIcon(flags.projectId).pipe(
            Effect.provide([
              ProjectStore.layer.pipe(
                Layer.provide(NodeSqliteClient.layer({ filename: config.dbPath, readonly: true })),
              ),
              ProjectFaviconResolver.layer.pipe(
                Layer.provide(T3ProjectFileLoader.layer),
                Layer.provideMerge(WorkspacePaths.layer),
              ),
              ServerConfig.layer(config),
            ]),
          )
        : null;
      yield* Console.log(encodeUnknownJson(icon));
    }).pipe(Effect.provideService(Logger.LogToStderr, true)),
  ),
);
