import * as NodeFS from "node:fs";
import { assertPilotRuntime } from "./server-test-pilot.mjs";

// Runs inside Vitest, independently of the driver and installer configuration.
export default class PilotRuntimeReporter {
  onInit() {
    NodeFS.writeFileSync(
      process.env.T3CODE_SERVER_PILOT_RUNTIME_PATH,
      JSON.stringify({ node: process.version, executable: process.execPath }, null, 2),
    );
    assertPilotRuntime(process.version);
  }
}
