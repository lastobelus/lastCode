// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { cases } from "./cases.ts";
import type { Results, Sample } from "./metrics.ts";
import { isInside, outsideHome, positive } from "./paths.ts";
import { git, wrapperWaitInstruction } from "./project.ts";
import { openSampleDatabase, readOnlySnapshots, retainedActionHoldIds } from "./read-sample.ts";
import { observeFamily, sampleMetrics, standing } from "./sample.ts";

function readResults(path: string, config: Results["config"]): Results {
  if (!NodeFS.existsSync(path)) return { version: 2, config, samples: [] };
  const data = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Results;
  if (data.version !== 2 || JSON.stringify(data.config) !== JSON.stringify(config)) {
    throw new Error(
      "Results file belongs to another run configuration. Choose a new --results path.",
    );
  }
  return data;
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "server-home": { type: "string" },
      "thread-id": { type: "string" },
      "project-id": { type: "string" },
      "fixtures-root": { type: "string" },
      "worktrees-root": { type: "string" },
      workspace: { type: "string" },
      arm: { type: "string" },
      case: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      results: { type: "string" },
      "duration-scale": { type: "string", default: "1" },
      "timeout-seconds": { type: "string", default: "900" },
    },
  });
  const { arm, provider, model, effort } = values;
  const threadId = values["thread-id"];
  const projectId = values["project-id"];
  const scenario = cases.find(({ id }) => id === values.case);
  if (
    !values["server-home"] ||
    !values["fixtures-root"] ||
    !values["worktrees-root"] ||
    !values.workspace ||
    !values.results ||
    !threadId ||
    !projectId ||
    (arm !== "a" && arm !== "b") ||
    (provider !== "claudeAgent" && provider !== "codex") ||
    !model ||
    !scenario
  ) {
    throw new Error(
      "Usage: grade-sample.ts --server-home DIR --thread-id ID --project-id ID --workspace DIR --fixtures-root DIR --worktrees-root DIR --arm a|b --case ID --provider claudeAgent|codex --model MODEL --results FILE [--timeout-seconds N] [--effort LEVEL] [--duration-scale N]",
    );
  }
  const home = NodeFS.realpathSync(values["server-home"]);
  const workspace = outsideHome(home, values.workspace);
  const fixturesRoot = NodeFS.realpathSync(values["fixtures-root"]);
  const worktreesRoot = NodeFS.realpathSync(values["worktrees-root"]);
  const resultsPath = outsideHome(home, values.results);
  if (!isInside(fixturesRoot, workspace))
    throw new Error("Workspace must be under --fixtures-root.");
  const config: Results["config"] = {
    arm,
    provider,
    model,
    ...(effort ? { effort } : {}),
    head: git(["rev-parse", "HEAD"]).trim(),
    sampling: "external",
    scale: positive(values["duration-scale"], "duration-scale", false),
    base: home,
  };
  const timeoutMs = positive(values["timeout-seconds"], "timeout-seconds") * 1000;
  const saved = (data: Results) => {
    const existing = data.samples.find((row) => row.threadId === threadId);
    if (
      existing &&
      (existing.caseId !== scenario.id ||
        existing.projectId !== projectId ||
        existing.workspace !== workspace)
    ) {
      throw new Error("This thread already belongs to a different fixture in the results file.");
    }
    return existing?.result;
  };
  const previous = saved(readResults(resultsPath, config));
  if (previous) {
    console.log(JSON.stringify(previous, null, 2));
    return;
  }

  using db = openSampleDatabase(home);
  const root = db
    .prepare(`
    SELECT thread.title, project.workspace_root
    FROM orchestration_v2_projection_threads AS thread
    JOIN projection_projects AS project ON project.project_id = thread.project_id
    WHERE thread.thread_id = ? AND thread.project_id = ? AND thread.deleted_at IS NULL
  `)
    .get(threadId, projectId);
  if (
    !root ||
    typeof root.workspace_root !== "string" ||
    NodeFS.realpathSync(root.workspace_root) !== workspace
  ) {
    throw new Error("Thread, project and fixture workspace do not match in the selected database.");
  }
  const sample: Sample = {
    caseId: scenario.id,
    index: 0,
    title: String(root.title),
    workspace,
    threadId,
    projectId,
    holds: [],
  };
  const snapshots = readOnlySnapshots(db);
  const observations = await observeFamily({
    sample,
    scenario,
    arm,
    db,
    timeoutMs,
    save: () => {},
    read: async (ids) => snapshots(ids),
  });
  if (!observations.settled)
    throw new Error(
      "Thread family did not settle for 12 seconds before --timeout-seconds. No grade was written.",
    );

  const startedAt = db
    .prepare(`
    SELECT json_extract(payload_json, '$.startedAt') AS started_at FROM orchestration_v2_projection_runs
    WHERE thread_id = ? AND started_at IS NOT NULL ORDER BY ordinal LIMIT 1
  `)
    .get(threadId)?.started_at;
  if (typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)))
    sample.launchedAt = Date.parse(startedAt);
  if (arm === "a") {
    sample.holds = [
      ...new Set([
        ...sample.holds,
        ...retainedActionHoldIds(
          db,
          observations.latest.at(-1)!.thread.threadId,
          scenario.actionId,
        ),
      ]),
    ];
  }
  sample.result = sampleMetrics({
    base: home,
    sample,
    scenario,
    config,
    observations,
    waitInstruction: wrapperWaitInstruction(),
    standingEstimate: standing(arm, scenario, provider),
    retrospective: true,
    allowedCheckout: (path) => {
      if (!path) return false;
      try {
        const actual = NodeFS.realpathSync(path);
        return scenario.delegated
          ? isInside(worktreesRoot, actual) && actual !== workspace
          : actual === workspace;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  });
  // Hold the output lock only while merging the completed sample.
  const lock = resultsPath + ".lock";
  NodeFS.closeSync(NodeFS.openSync(lock, "wx", 0o600));
  try {
    const data = readResults(resultsPath, config);
    const concurrent = saved(data);
    if (concurrent) {
      console.log(JSON.stringify(concurrent, null, 2));
      return;
    }
    sample.index =
      1 +
      Math.max(
        0,
        ...data.samples.filter((row) => row.caseId === scenario.id).map((row) => row.index),
      );
    data.samples.push(sample);
    const temporary = resultsPath + "." + NodeCrypto.randomUUID();
    NodeFS.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    NodeFS.renameSync(temporary, resultsPath);
    console.log(JSON.stringify(sample.result, null, 2));
  } finally {
    NodeFS.unlinkSync(lock);
  }
}

await main();
