import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentPauseStore from "../environment/EnvironmentPauseStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as Capacity from "./Capacity.ts";
import { capacityActivity } from "./activity.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const power = yield* HostPowerMonitor.HostPowerMonitor;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const pauseStore = yield* EnvironmentPauseStore.EnvironmentPauseStore;
    return Capacity.layer({
      mode: settings.getSettings.pipe(
        Effect.map((current) => current.capacityMode),
        Effect.orElseSucceed(() => "observe" as const),
      ),
      ownerPower: power.snapshot,
      worktreesDir: settings.getSettings.pipe(
        Effect.map((current) =>
          resolveWorktreesDirectory(current.worktreesDirectory, config.worktreesDir, path, home),
        ),
      ),
      activity: Effect.gen(function* () {
        const shell = yield* projections.getShellSnapshot();
        const session = yield* pauseStore.get;
        const automationPaused = session !== null && session.phase !== "resuming";
        const deferred = automationPaused ? yield* outbox.deferredAutomaticExecution : [];
        return capacityActivity(
          [...shell.threads, ...shell.archivedThreads],
          deferred,
          automationPaused,
        );
      }),
    });
  }),
).pipe(
  Layer.provide(ProjectionStore.layer),
  Layer.provide(EffectOutbox.layer),
  Layer.provide(EnvironmentPauseStore.layer),
);
