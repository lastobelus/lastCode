import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, getInitialServerConfig } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

export function createEnvironmentBootstrapQuery<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return createEnvironmentQueryAtomFamily(runtime, {
    label: "environment.bootstrap",
    staleTimeMs: 0,
    execute: Effect.fn("clientRuntime.state.bootstrap")(function* (_input: void) {
      const config = yield* getInitialServerConfig();
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId: supervisor.target.environmentId,
          message: "The environment connection is not ready.",
        });
      }
      return { config, prepared: prepared.value };
    }),
  });
}
