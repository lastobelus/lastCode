import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Capacity from "./Capacity.ts";
import * as CapacityLive from "./live.ts";

it.effect("provides live capacity in the production route graph", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const server = yield* fs.readFileString(new URL("../server.ts", import.meta.url).pathname);
    expect(server).toContain('import * as CapacityLive from "./capacity/live.ts";');
    expect(server).toContain(
      "Layer.provide(CapacityLive.layer.pipe(Layer.provide(layerHostPowerMonitor)))",
    );
    const snapshot = yield* Effect.flatMap(Capacity.Capacity, (capacity) => capacity.read).pipe(
      Effect.provide(
        CapacityLive.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Settings.ServerSettingsService)({
                getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, capacityMode: "off" }),
              }),
              Layer.mock(HostPowerMonitor.HostPowerMonitor)({ snapshot: Effect.never }),
              SqlitePersistence.layerMemory,
            ),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "capacity-live-" })),
        ),
      ),
    );
    expect(snapshot.mode).toBe("off");
    expect(snapshot.verdicts.owner.state).toBe("open");
    expect(snapshot.verdicts.agent.state).toBe("unknown");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
