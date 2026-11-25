// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { codexBackgroundWaitInstructions } from "../../apps/server/src/provider/LastCodeBackgroundWait.ts";
import { checkActionCatalog, standingActionPolicy } from "./actionPolicy.ts";
import type { Arm, Scenario } from "./cases.ts";
import {
  gradeSample,
  type Results,
  type Sample,
  type SampleResult,
  type WorkEvent,
} from "./metrics.ts";
import {
  awaitedWrapperIds,
  nativeLogName,
  ownedWorkerLookup,
  readCodexRollout,
  readLines,
  readNative,
  wrapperWakeIds,
  type PendingWork,
} from "./observe.ts";
import { existingFile, isInside } from "./paths.ts";
import { fixtureGuidance, repositoryFile } from "./project.ts";

export interface Snapshot {
  thread: {
    threadId: string;
    status: string;
    runCount: number;
    activeRunId: string | null;
    pendingRequestCount: number;
    worktreePath: string | null;
    model: string;
    providerInstanceId: string;
    pendingBackgroundTasks?: readonly PendingWork[] | null;
    actionResume?: {
      runId: string;
      actionId: string;
      delivery: string;
      status: { state: string };
    } | null;
  };
  messages: Array<{ role: string; text: string }>;
}

export function isQuiescent({ thread }: Snapshot) {
  return (
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(thread.status) &&
    thread.activeRunId === null &&
    thread.pendingRequestCount === 0 &&
    !thread.pendingBackgroundTasks?.length &&
    (thread.actionResume == null ||
      (!["armed", "pending"].includes(thread.actionResume.delivery) &&
        !["follow_up_queued", "follow_up_active"].includes(thread.actionResume.status.state)))
  );
}

function holdIds({ thread }: Snapshot, arm: Arm, scenario: Scenario): string[] {
  if (arm === "a") {
    const action = thread.actionResume;
    return action?.actionId === scenario.actionId && action.delivery === "armed"
      ? [action.runId]
      : [];
  }
  if (thread.activeRunId !== null && thread.status !== "waiting") return [];
  return awaitedWrapperIds(thread.pendingBackgroundTasks ?? [], thread.providerInstanceId);
}

export function standing(arm: Arm, scenario: Scenario, provider: Results["config"]["provider"]) {
  // Estimate only the portions relevant to this comparison. Deferred tool presentation differs by provider.
  const approx = (value: string) => Math.ceil(Buffer.byteLength(value) / 4);
  const policy = standingActionPolicy(arm === "b", provider);
  const isClaude = provider === "claudeAgent";
  const needsCodexWait = arm === "b" && !isClaude;
  const backgroundInstruction = needsCodexWait ? codexBackgroundWaitInstructions(true).trim() : "";
  if (needsCodexWait && backgroundInstruction === "")
    throw new Error(
      "apps/server/src/provider/LastCodeBackgroundWait.ts: codexBackgroundWaitInstructions(true) returned no guidance.",
    );
  const project = fixtureGuidance(scenario, arm) + (isClaude ? repositoryFile("CLAUDE.md") : "");
  return {
    guidance: approx(project + policy.instructions),
    toolDefinitions: approx(policy.toolDefinitions),
    backgroundWaitInstruction: approx(backgroundInstruction),
  };
}

export async function observeFamily(input: {
  sample: Sample;
  scenario: Scenario;
  arm: Arm;
  db: NodeSqlite.DatabaseSync;
  timeoutMs: number;
  save: () => void;
  read: (ids: readonly string[]) => Promise<Snapshot[]>;
}) {
  const { sample, scenario, arm, db } = input;
  const rootId = sample.threadId!;
  const workers = ownedWorkerLookup(db);
  let quietSince: number | undefined;
  let quietFamily = "";
  let latest: Snapshot[] = [];
  let settled = false;
  let finished = false;
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    const rows = workers.all(rootId, sample.projectId!);
    latest = await input.read([rootId, ...rows.map((row) => String(row.thread_id))]);
    const worker = latest.at(-1)!;
    const holds = !scenario.delegated || latest.length > 1 ? holdIds(worker, arm, scenario) : [];
    for (const id of holds) {
      if (!sample.holds.includes(id)) {
        sample.holds.push(id);
        input.save();
      }
    }
    const quiescent = latest.every(isQuiescent);
    if (quiescent) {
      const family = JSON.stringify(
        latest.map(({ thread }) => [thread.threadId, thread.runCount, thread.status]),
      );
      if (quietSince === undefined || quietFamily !== family) {
        quietSince = Date.now();
        quietFamily = family;
      }
      if (Date.now() - quietSince >= 12_000) {
        settled = true;
        finished = latest.every((snapshot) => snapshot.thread.status === "completed");
        break;
      }
    } else {
      quietSince = undefined;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await NodeTimersPromises.setTimeout(Math.min(2_000, remaining));
  }
  const wakes = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL) AS delegated,
      COUNT(*) FILTER (WHERE json_extract(payload_json, '$.text') GLOB 'Automated Project Action follow-up.*') AS actions
    FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user'
  `);
  const lastCompletion = db.prepare(
    "SELECT MAX(completed_at) AS completed_at FROM orchestration_v2_projection_runs WHERE thread_id = ?",
  );
  const endedAt = Math.max(
    0,
    ...latest.flatMap(({ thread }) => {
      const time = lastCompletion.get(thread.threadId)?.completed_at;
      return typeof time === "string" ? [Date.parse(time)] : [];
    }),
  );
  return {
    latest,
    settled,
    finished,
    endedAt: endedAt || quietSince || Date.now(),
    completedAt: endedAt || null,
    delegatedCompletions: Number(wakes.get(rootId)?.delegated),
    actionWakes: Number(wakes.get(latest.at(-1)!.thread.threadId)?.actions),
    wrapperWakeIds: arm === "b" ? wrapperWakeIds(db, latest.at(-1)!.thread.threadId) : [],
  };
}

function readWork(base: string, workspace: string): WorkEvent[] {
  const path = NodePath.join(workspace, "work.jsonl");
  return NodeFS.existsSync(path)
    ? (readLines(NodeFS.readFileSync(existingFile(base, path), "utf8")) as unknown as WorkEvent[])
    : [];
}

export function readThreadEvidence(
  base: string,
  thread: Snapshot["thread"],
  provider: Results["config"]["provider"],
) {
  const file = NodePath.join(base, "userdata/logs/provider", nativeLogName(thread.threadId));
  const native = readNative(
    NodeFS.existsSync(file) ? NodeFS.readFileSync(existingFile(base, file), "utf8") : "",
    provider,
  );
  if (provider === "claudeAgent") {
    return { native, trace: native.turns === thread.runCount ? native.trace : undefined };
  }
  // The app-server's item stream omits write_stdin; read the actual model-facing tool transcript.
  const rolloutHome = NodePath.join(base, "codex-home");
  const rollouts = new Set(
    native.rolloutPaths.flatMap((path) => {
      if (!isInside(rolloutHome, path)) return [];
      const archived = NodePath.join(rolloutHome, "archived_sessions", NodePath.basename(path));
      const found = [path, archived].find((candidate) => NodeFS.existsSync(candidate));
      return found === undefined ? [] : [existingFile(rolloutHome, found)];
    }),
  );
  const traces = [...rollouts].map((path) => readCodexRollout(NodeFS.readFileSync(path, "utf8")));
  return {
    native,
    trace:
      traces.length > 0 && traces.reduce((sum, trace) => sum + trace.turns, 0) === thread.runCount
        ? traces.flatMap((trace) => trace.trace)
        : undefined,
  };
}

export function sampleMetrics(input: {
  base: string;
  sample: Sample;
  scenario: Scenario;
  config: Results["config"];
  waitInstruction: string;
  standingEstimate: SampleResult["standing"];
  observations: Awaited<ReturnType<typeof observeFamily>>;
  allowedCheckout?: (path: string) => boolean;
  retrospective?: boolean;
}) {
  const { base, sample, scenario, config, observations, waitInstruction } = input;
  const { latest, finished, endedAt } = observations;
  const parent = latest[0]!;
  const worker = latest.at(-1)!;
  const evidence = latest.map(({ thread }) => readThreadEvidence(base, thread, config.provider));
  const finalMessage = (snapshot: Snapshot) =>
    snapshot.messages.findLast((message) => message.role === "assistant")?.text ?? "";
  const workspace = scenario.delegated ? (worker.thread.worktreePath ?? "") : sample.workspace!;
  const allowedCheckout = input.allowedCheckout ?? ((path) => isInside(base, path));
  const work = readWork(input.retrospective ? sample.workspace! : base, sample.workspace!);
  const result = gradeSample({
    arm: config.arm,
    scenario,
    finished,
    correctCheckout:
      allowedCheckout(workspace) &&
      (!scenario.delegated || workspace !== sample.workspace) &&
      work.every((row) => row.cwd === workspace),
    delegationCorrect:
      latest.length === (scenario.delegated ? 2 : 1) &&
      observations.delegatedCompletions === (scenario.delegated ? 1 : 0) &&
      latest.every(
        ({ thread }) =>
          thread.providerInstanceId === config.provider && thread.model === config.model,
      ),
    turns: latest.reduce((sum, snapshot) => sum + snapshot.thread.runCount, 0),
    expectedTurnCounts: latest.map(({ thread }) => thread.runCount),
    holds: sample.holds,
    retrospective: input.retrospective === true,
    wrapperWakeIds: observations.wrapperWakeIds,
    actionWakes: observations.actionWakes,
    actionRunObserved: latest.some(({ thread }) => thread.actionResume != null),
    workerMessage: finalMessage(worker),
    finalMessage: finalMessage(parent),
    work,
    native: evidence.map(({ native }) => native),
    traces: evidence.every(({ trace }) => trace !== undefined)
      ? evidence.map(({ trace }) => trace!)
      : null,
    waitInstruction,
    wallSeconds:
      sample.launchedAt === undefined || (input.retrospective && observations.completedAt === null)
        ? null
        : Math.round((endedAt - sample.launchedAt) / 100) / 10,
    standing: input.standingEstimate,
  });
  if (input.retrospective && config.provider === "claudeAgent") {
    result.actionCatalogs = evidence.map(({ native }) =>
      checkActionCatalog(native.toolCatalog, config.arm === "b"),
    );
    if (result.actionCatalogs.includes("mismatch")) {
      result.correct = false;
      result.setupFault = true;
      result.problems.push(
        "Harness or product fault: the provider's Action tool catalog did not match the eval arm.",
      );
    }
  }
  return result;
}
