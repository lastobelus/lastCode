import { createEnvironmentPauseAtoms } from "@t3tools/client-runtime/state/environment-pause";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentPause = createEnvironmentPauseAtoms(connectionAtomRuntime);
