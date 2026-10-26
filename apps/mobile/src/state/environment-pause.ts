import { createEnvironmentPauseAtoms } from "@t3tools/client-runtime/state/environment-pause";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { workspaceConnections } from "./workspace";

export const environmentPause = createEnvironmentPauseAtoms(connectionAtomRuntime);

type PauseConnection = EnvironmentConnectionSummary & {
  readonly connected: boolean;
  readonly since: number;
};

export function createEnvironmentPauseConnectionsAtom(
  environmentsAtom: Atom.Atom<readonly EnvironmentConnectionSummary[]>,
) {
  return Atom.make((get) => {
    const previous = Option.getOrNull(get.self<readonly PauseConnection[]>());
    return get(environmentsAtom).map((environment) => {
      const connected = environment.isEnabled && environment.connectionState === "connected";
      const prior = previous?.find(
        (candidate) => candidate.environmentId === environment.environmentId,
      );
      return {
        ...environment,
        connected,
        since: prior && prior.connected === connected ? prior.since : Date.now(),
      };
    });
  });
}

export const environmentPauseConnectionsAtom = createEnvironmentPauseConnectionsAtom(
  workspaceConnections.environmentsAtom,
);
