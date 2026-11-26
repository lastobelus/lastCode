// @effect-diagnostics nodeBuiltinImport:off -- Local generator writes the committed measurement.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { measureAgentContextBudget } from "../src/provider/AgentContextBudget.ts";

const measured = await Effect.runPromise(measureAgentContextBudget);
NodeFS.writeFileSync(
  new URL("../src/provider/agentContextBudget.json", import.meta.url),
  `${JSON.stringify(measured, null, 2)}\n`,
);
