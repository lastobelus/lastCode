// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { cases, taskPrompt } from "./cases.ts";
import { outsideHome, positive } from "./paths.ts";
import { makeProject } from "./project.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "server-home": { type: "string" },
    workspace: { type: "string" },
    arm: { type: "string" },
    case: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "duration-scale": { type: "string", default: "1" },
  },
});
const { arm, model, effort } = values;
const scenario = cases.find(({ id }) => id === values.case);
if (
  !values["server-home"] ||
  !values.workspace ||
  (arm !== "a" && arm !== "b") ||
  !scenario ||
  !model
) {
  throw new Error(
    "Usage: make-fixture.ts --server-home DIR --workspace NEW_DIR --arm a|b --case ID --model MODEL [--effort LEVEL] [--duration-scale N]",
  );
}

const workspace = outsideHome(NodeFS.realpathSync(values["server-home"]), values.workspace);
const scale = positive(values["duration-scale"], "duration-scale", false);
const action = makeProject(
  workspace,
  arm,
  scenario,
  Math.max(1, Math.round(scenario.seconds * scale)),
);
console.log(
  JSON.stringify({ workspace, action, prompt: taskPrompt(scenario, arm, model, effort) }, null, 2),
);
