// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
// This source is copied into each synthetic checkout under the real script names.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

export interface FixtureConfig {
  workspace: string;
  script: string;
  args: string[];
  seconds: number;
  exitCode: number;
  stages: number;
}

function runLog(workspace: string, entry: object) {
  NodeFS.appendFileSync(NodePath.join(workspace, "work.jsonl"), JSON.stringify(entry) + "\n", {
    mode: 0o600,
  });
}

function readLog(workspace: string): Array<Record<string, unknown>> {
  try {
    return NodeFS.readFileSync(NodePath.join(workspace, "work.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** @public Copied into the stand-in project and imported by its script entry points. */
export async function runFixture(config: FixtureConfig) {
  const script = NodePath.basename(process.argv[1] ?? "");
  const args = process.argv.slice(2);
  if (
    script === "prepare-dependencies.ts" &&
    args.join(" ") === "--for-ci" &&
    config.script === "lastcode-local-ci.ts"
  ) {
    return;
  }
  if (script === "ack.ts" && config.stages > 1) {
    const result = readLog(config.workspace).at(-1);
    const ids = result?.milestones;
    if (
      result?.event !== "finish" ||
      !Array.isArray(ids) ||
      ids.length === 0 ||
      args.join(" ") !== ids.join(" ")
    ) {
      throw new Error("Give the two milestone IDs from the latest batch in the order reported.");
    }
    runLog(config.workspace, { event: "ack", cwd: process.cwd(), ids, at: Date.now() });
    console.log("Milestones acknowledged.");
    return;
  }
  if (script !== config.script || args.join(" ") !== config.args.join(" ")) {
    throw new Error("Unexpected operation or arguments.");
  }
  const previous = readLog(config.workspace);
  const stage = previous.filter((entry) => entry.event === "finish").length;
  if (stage >= config.stages || (stage > 0 && previous.at(-1)?.event !== "ack")) {
    throw new Error("The last batch still needs acknowledgement, or the queue has drained.");
  }
  const operationId = NodeCrypto.randomBytes(6).toString("hex");
  runLog(config.workspace, {
    event: "start",
    operationId,
    stage,
    cwd: process.cwd(),
    at: Date.now(),
    arm: process.env.T3CODE_ACTION_RUN_ID ? "a" : "b",
    markedEnvironment: process.env.LASTCODE_BACKGROUND_WAIT === "1",
  });

  const deadline = Date.now() + config.seconds * 1000;
  console.log("Checking workspace inputs…");
  let digest = operationId;
  while (Date.now() < deadline) {
    digest = NodeCrypto.createHash("sha256").update(digest).digest("hex");
    await NodeTimersPromises.setTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
  }

  const resultId = `result-${digest.slice(0, 12)}`;
  const milestones =
    stage + 1 < config.stages ? [`ms-${digest.slice(12, 20)}`, `ms-${digest.slice(20, 28)}`] : [];
  let summary =
    milestones.length > 0
      ? `Milestones: ${milestones.join(" ")}. Result ID ${resultId}.`
      : `${config.stages > 1 ? "Queue drained. " : ""}Result ID ${resultId}.`;
  const facts =
    config.script === "lastcode-build-local-package.ts"
      ? { dmgPath: "artifacts/LastCode.dmg" }
      : undefined;
  if (facts) {
    NodeFS.mkdirSync("artifacts", { recursive: true });
    NodeFS.writeFileSync(facts.dmgPath, resultId + "\n");
    summary += ` Artifact: ${facts.dmgPath}.`;
  }
  runLog(config.workspace, {
    event: "finish",
    stage,
    cwd: process.cwd(),
    operationId,
    resultId,
    milestones,
    at: Date.now(),
  });
  // Project Actions discard the structured report when the process exits nonzero.
  // Give the Action's stdout tail the same result ID the wrapper gets from the report.
  if (config.exitCode !== 0 && process.env.T3CODE_ACTION_RUN_ID) console.log(summary);
  return {
    outcome: config.exitCode === 0 ? ("success" as const) : ("attention" as const),
    summary,
    ...(facts ? { facts } : {}),
  };
}
