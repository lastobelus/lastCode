import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqliteWithoutMigrations from "../persistence/SqliteWithoutMigrations.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

export const layer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(Layer.mergeAll(ServerSecretStore.layer, SqliteWithoutMigrations.layerConfig)),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
