import {
  createEnvironmentPauseAtoms,
  createEnvironmentPauseConnectionsAtom,
} from "@t3tools/client-runtime/state/environment-pause";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";

export const environmentPause = createEnvironmentPauseAtoms(connectionAtomRuntime);
export const environmentPauseConnectionsAtom = createEnvironmentPauseConnectionsAtom(
  environmentSummaries.environmentsAtom,
);
