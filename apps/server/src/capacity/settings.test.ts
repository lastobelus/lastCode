import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect("preserves a newer capacity mode in the settings file across an unrelated update", () =>
  Effect.gen(function* () {
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* fs.writeFileString(
      settingsPath,
      JSON.stringify({ capacityMode: "enforce", responseStreamingMode: "turn" }),
    );

    expect(yield* settings.getSettings).toMatchObject({
      capacityMode: "enforce",
      responseStreamingMode: "turn",
    });
    yield* settings.updateSettings({ enableProviderUpdateChecks: false });

    expect(JSON.parse(yield* fs.readFileString(settingsPath))).toMatchObject({
      capacityMode: "enforce",
      responseStreamingMode: "turn",
      enableProviderUpdateChecks: false,
    });
  }).pipe(
    Effect.provide(
      ServerSettings.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "capacity-settings-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
