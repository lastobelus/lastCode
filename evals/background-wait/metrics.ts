// @effect-diagnostics globalConsole:off
import {
  gradeTrace,
  type NativeEvidence,
  type TraceEvent,
  type Usage,
  sumUsage,
} from "./observe.ts";
import type { Arm, Scenario } from "./cases.ts";
import type { ActionCatalogCheck } from "./actionPolicy.ts";

export interface SampleResult {
  finished: boolean;
  correct: boolean;
  problems: string[];
  setupFault?: boolean;
  actionCatalogs?: readonly ActionCatalogCheck[];
  turns: number;
  requests: number | null;
  tokens: Usage | null;
  rawTokens: number | null;
  polls: number | null;
  redundantMarks: number | null;
  waitToolLookups: number | null;
  extraCallsWhileWaiting: number | null;
  holdEngaged: boolean | null;
  holds: number | null;
  holdExpected: number | null;
  wallSeconds: number | null;
  firstInput: number | null;
  contextGrowth: number | null;
  standing: { guidance: number; toolDefinitions: number; backgroundWaitInstruction: number };
  standingAcrossRequests: number | null;
}

export interface WorkEvent {
  event: string;
  cwd: string;
  stage?: number;
  operationId?: string;
  arm?: Arm;
  resultId?: string;
  at?: number;
  ids?: string[];
  milestones?: string[];
}

interface GradeInput {
  arm: Arm;
  scenario: Scenario;
  finished: boolean;
  correctCheckout: boolean;
  delegationCorrect: boolean;
  turns: number;
  expectedTurnCounts: number[];
  holds: readonly string[];
  retrospective?: boolean;
  wrapperWakes: ReadonlyMap<string, string>;
  actionWakes: number;
  actionRunObserved?: boolean;
  workerMessage: string;
  finalMessage: string;
  work: WorkEvent[];
  native: NativeEvidence[];
  traces: TraceEvent[][] | null;
  waitInstruction?: string;
  wallSeconds: number | null;
  standing: SampleResult["standing"];
}

export function gradeSample(input: GradeInput): SampleResult {
  const { arm, scenario, work, finished, native, traces, finalMessage, workerMessage } = input;
  const stages = scenario.stages ?? 1;
  const problems: string[] = [];
  if (!finished) problems.push("Thread family did not complete.");
  if (!input.correctCheckout || !input.delegationCorrect)
    problems.push("Wrong checkout or delegated worker.");
  const starts = work.filter((row) => row.event === "start");
  const exits = work.filter((row) => row.event === "finish");
  const acknowledgements = work.filter((row) => row.event === "ack");
  const expectedEvents = Array.from({ length: stages }, (_, stage) =>
    stage + 1 === stages ? ["start", "finish"] : ["start", "finish", "ack"],
  ).flat();
  if (
    work.map((row) => row.event).join(",") !== expectedEvents.join(",") ||
    starts.some(
      (row, index) =>
        row.arm !== arm || row.operationId !== exits[index]?.operationId || row.stage !== index,
    ) ||
    acknowledgements.some(
      (row, index) => row.ids?.join(" ") !== exits[index]?.milestones?.join(" "),
    )
  )
    problems.push("Wrong execution path, launch count, or milestone acknowledgements.");
  const resultId = exits.at(-1)?.resultId;
  const reportsResult = (message: string) =>
    resultId !== undefined &&
    message.includes(resultId) &&
    new RegExp(
      `\\bexit(?:ed)?(?:\\s+(?:with|status|code))*(?:\\s+was)?[\\s:=(]*${scenario.exitCode}\\b`,
      "iu",
    ).test(message.replaceAll(/[`*_]/gu, ""));
  if (!reportsResult(finalMessage) || !reportsResult(workerMessage)) {
    problems.push("Final response omitted the exact result ID or exit code.");
  }
  if (scenario.id === "package" && !finalMessage.includes("artifacts/LastCode.dmg")) {
    problems.push("Final response omitted the artifact path.");
  }

  const observed = traces?.map((trace, index) =>
    gradeTrace(
      trace,
      input.waitInstruction,
      arm === "b",
      index === traces.length - 1 ? { holds: input.holds, wakes: input.wrapperWakes } : undefined,
    ),
  );
  const forbiddenAction =
    arm === "b" &&
    (input.actionRunObserved === true ||
      input.actionWakes > 0 ||
      starts.some((row) => row.arm === "a") ||
      observed?.some((trace) => trace.actionWaits > 0));
  if (forbiddenAction)
    problems.push("Harness or product fault: a Project Action launched in the wrapper arm.");
  const worker = observed?.at(-1);
  const polls = observed?.reduce((sum, trace) => sum + trace.polls, 0) ?? null;
  const redundantMarks = observed?.reduce((sum, trace) => sum + trace.redundantMarks, 0) ?? null;
  const waitToolLookups = observed?.reduce((sum, trace) => sum + trace.waitToolLookups, 0) ?? null;
  const extraCallsWhileWaiting =
    observed?.reduce((sum, trace) => sum + trace.extraCallsWhileWaiting, 0) ?? null;
  const holdExpected = worker === undefined ? null : arm === "a" ? stages : worker.markers;
  const waitEvidence = worker?.waitEvidence ?? input.holds.length;
  const confirmed = input.retrospective ? waitEvidence : input.holds.length;
  const holds =
    input.retrospective && (holdExpected === null || confirmed < holdExpected) ? null : confirmed;
  if (worker === undefined) {
    problems.push("Tool trace incomplete.");
  } else {
    if (
      arm === "a" &&
      (worker.lists < 1 ||
        worker.actions !== stages ||
        worker.actionWaits !== stages ||
        input.actionWakes !== stages)
    ) {
      problems.push("Worker did not list and launch the required resumable Actions.");
    }
    if (
      arm === "b" &&
      !forbiddenAction &&
      (worker.actions !== 0 ||
        input.actionWakes !== 0 ||
        worker.wrapperCalls !== stages ||
        worker.markers + worker.terminalWrapperOutputs !== stages)
    ) {
      problems.push("Worker did not use the wrapper for each operation.");
    }
    if (arm === "b" && waitEvidence < worker.markers)
      problems.push(
        input.retrospective
          ? "Expected wrapper wait had no retained hold or result wake evidence."
          : "Expected wrapper wait had neither an observed hold nor a delivered result wake.",
      );
    if (extraCallsWhileWaiting !== 0)
      problems.push("An unexpected tool was called after the instruction to end the turn.");
  }
  const completeUsage =
    native.length === input.expectedTurnCounts.length &&
    native.every(
      (evidence, index) => evidence.complete && evidence.turns === input.expectedTurnCounts[index],
    );
  const requests = completeUsage
    ? native.reduce((sum, evidence) => sum + evidence.requests, 0)
    : null;
  const tokens = completeUsage ? sumUsage(native.map((evidence) => evidence.usage)) : null;
  const parent = native[0];
  return {
    finished,
    correct: problems.length === 0,
    problems,
    ...(forbiddenAction || (arm === "b" && input.retrospective && holds === null)
      ? { setupFault: true }
      : {}),
    turns: input.turns,
    requests,
    tokens,
    rawTokens: tokens === null ? null : tokens.input + tokens.output,
    polls,
    redundantMarks,
    waitToolLookups,
    extraCallsWhileWaiting,
    holdEngaged: confirmed > 0 ? true : holds === null ? null : false,
    holds,
    holdExpected,
    wallSeconds: input.wallSeconds,
    firstInput: completeUsage ? (parent?.contexts[0] ?? null) : null,
    contextGrowth:
      completeUsage && parent?.contexts[0] !== undefined
        ? (parent.contexts.at(-1) ?? parent.contexts[0]) - parent.contexts[0]
        : null,
    standing: input.standing,
    standingAcrossRequests:
      requests === null
        ? null
        : Object.values(input.standing).reduce((sum, value) => sum + value, 0) * requests,
  };
}

export interface ThreadLaunch {
  title: string;
  projectId?: string;
  threadId?: string;
  launchedAt?: number;
}

export interface Sample extends ThreadLaunch {
  caseId: string;
  index: number;
  workspace?: string;
  holds: string[];
  result?: SampleResult;
}

export interface Results {
  version: 1 | 2;
  config: {
    arm: Arm;
    provider: "codex" | "claudeAgent";
    model: string;
    effort?: string;
    head: string;
    serverCli?: string;
    sampling?: "external";
    scale: number;
    base: string;
  };
  catalogProbe?: ThreadLaunch & { tools?: readonly string[] };
  samples: Sample[];
}

export function requireCompleteSamples(samples: readonly Sample[], signal?: string) {
  const missing = samples.filter((sample) => sample.result === undefined);
  if (missing.length === 0) return;
  const awaitingGrade = missing.filter((sample) => sample.launchedAt !== undefined).length;
  throw new Error(
    `Run incomplete${signal === undefined ? "" : ` after ${signal}`}. ` +
      `Graded ${samples.length - missing.length}/${samples.length}; ${awaitingGrade} started and awaiting a grade, ` +
      `${missing.length - awaitingGrade} not started. Repeat the same command to resume ${missing.length} samples.`,
  );
}

export function median(numbers: number[]): number {
  if (numbers.length === 0) throw new Error("Cannot calculate a median without observations.");
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2;
}

export function printCases(data: Results) {
  for (const id of new Set(data.samples.map((sample) => sample.caseId))) {
    console.log(`\n${id}, arm ${data.config.arm.toUpperCase()}`);
    console.table(
      data.samples
        .filter((sample) => sample.caseId === id)
        .map(({ index, result }) => ({
          sample: index,
          finished: result?.finished ?? null,
          correct: result?.correct ?? null,
          turns: result?.turns ?? null,
          requests: result?.requests ?? null,
          input: result?.tokens?.input ?? null,
          cached: result?.tokens?.cached ?? null,
          output: result?.tokens?.output ?? null,
          raw: result?.rawTokens ?? null,
          polls: result?.polls ?? null,
          redundantMarks: result?.redundantMarks ?? null,
          waitToolLookups: result?.waitToolLookups ?? null,
          hold:
            result === undefined ? null : `${result.holds ?? "?"}/${result.holdExpected ?? "?"}`,
          standing: result?.standingAcrossRequests ?? null,
          seconds: result?.wallSeconds ?? null,
        })),
    );
  }
}
