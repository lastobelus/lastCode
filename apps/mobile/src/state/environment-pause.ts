import {
  createEnvironmentPauseAtoms,
  createEnvironmentPauseConnectionsAtom,
} from "@t3tools/client-runtime/state/environment-pause";

import { connectionAtomRuntime } from "../connection/runtime";
import { workspaceConnections } from "./workspace";

export const environmentPause = createEnvironmentPauseAtoms(connectionAtomRuntime);

export const environmentPauseConnectionsAtom = createEnvironmentPauseConnectionsAtom(
  workspaceConnections.environmentsAtom,
);
