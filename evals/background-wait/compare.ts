// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import { cases } from "./cases.ts";
import { median, type Results, type SampleResult } from "./metrics.ts";

function load(path: string): Results {
  const data = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Results;
  if (data.version !== 1 || !Array.isArray(data.samples))
    throw new Error(`Invalid eval results: ${path}`);
  return data;
}

function paired(a: Results, b: Results, baselineHead?: string) {
  const { provider, model, effort, head, scale } = a.config;
  if (baselineHead !== undefined && baselineHead !== head) {
    throw new Error(`--baseline-head does not match arm A's recorded head ${head}.`);
  }
  if (
    a.config.arm !== "a" ||
    b.config.arm !== "b" ||
    b.config.provider !== provider ||
    b.config.model !== model ||
    b.config.effort !== effort ||
    (b.config.head !== head && baselineHead === undefined) ||
    b.config.scale !== scale
  ) {
    throw new Error(
      "Supply A then B with the same source revision, duration scale, provider, model, and effort.",
    );
  }
  const byCase = (data: Results, id: string) =>
    data.samples.filter((sample) => sample.caseId === id).toSorted((x, y) => x.index - y.index);
  return cases.flatMap(({ id }) => {
    const left = byCase(a, id);
    const right = byCase(b, id);
    if (left.length === 0 && right.length === 0) return [];
    if (left.map((row) => row.index).join(",") !== right.map((row) => row.index).join(",")) {
      throw new Error(`Mismatched sample indices for ${id}.`);
    }
    return [
      { case: id, a: left.map(({ result }) => result), b: right.map(({ result }) => result) },
    ];
  });
}

const mean = (numbers: number[]) => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
const values = (rows: (SampleResult | undefined)[], get: (row: SampleResult) => number | null) =>
  rows.flatMap((row) => (row === undefined ? [] : (get(row) ?? [])));
const completeMean = (
  rows: (SampleResult | undefined)[],
  get: (row: SampleResult) => number | null,
) => {
  const available = values(rows, get);
  return available.length === rows.length && available.length > 0 ? mean(available) : null;
};
const rounded = (value: number | null) => (value === null ? null : Math.round(value));
const total = (rows: (SampleResult | undefined)[], get: (row: SampleResult) => number | null) => {
  const available = values(rows, get);
  return available.length === rows.length ? available.reduce((sum, value) => sum + value, 0) : null;
};

export function compare(a: Results, b: Results, subsequentTurns: number, baselineHead?: string) {
  const cases = paired(a, b, baselineHead);
  const aResults = cases.flatMap((row) => row.a);
  const bResults = cases.flatMap((row) => row.b);
  const firstInputs = values(aResults, (row) => row.firstInput);
  const typicalContext = firstInputs.length === 0 ? null : median(firstInputs);
  const summarize = (rows: (SampleResult | undefined)[], wrapper = false) => {
    const growth = values(rows, (row) => row.contextGrowth);
    const typicalGrowth =
      growth.length === rows.length && growth.length > 0 ? median(growth) : null;
    const turns = completeMean(rows, (row) => row.turns);
    const formula = (later: number) =>
      typicalContext === null || typicalGrowth === null || turns === null
        ? null
        : rounded(turns * typicalContext + typicalGrowth * later);
    const requests = completeMean(rows, (row) => row.requests);
    const redundantMarks = total(rows, (row) => row.redundantMarks);
    const wrapperWaits = wrapper ? total(rows, (row) => row.holdExpected) : null;
    return {
      correct: rows.filter((row) => row?.correct).length,
      counted: rows.filter((row) => row !== undefined).length,
      scheduled: rows.length,
      turns: turns === null ? null : Math.round(turns * 100) / 100,
      requests: requests === null ? null : Math.round(requests * 100) / 100,
      raw: rounded(completeMean(rows, (row) => row.rawTokens)),
      input: rounded(completeMean(rows, (row) => row.tokens?.input ?? null)),
      cached: rounded(completeMean(rows, (row) => row.tokens?.cached ?? null)),
      output: rounded(completeMean(rows, (row) => row.tokens?.output ?? null)),
      standingAcrossRequests: rounded(completeMean(rows, (row) => row.standingAcrossRequests)),
      holds: rows.reduce((sum, row) => sum + (row?.holds ?? 0), 0),
      polls: total(rows, (row) => row.polls),
      redundantMarks,
      waitToolLookups: total(rows, (row) => row.waitToolLookups),
      wrapperWaits,
      redundantMarksPerWrapperWait:
        wrapperWaits && redundantMarks !== null ? redundantMarks / wrapperWaits : null,
      extraCallsWhileWaiting: total(rows, (row) => row.extraCallsWhileWaiting),
      typicalGrowth,
      projection: formula(subsequentTurns),
      projectionSensitivity: Object.fromEntries(
        [0, 1, 5, 10].map((later) => [later, formula(later)]),
      ),
    };
  };
  const summaries = cases.map((row) => ({
    case: row.case,
    a: summarize(row.a),
    b: summarize(row.b, true),
  }));
  const totals = { a: summarize(aResults), b: summarize(bResults, true) };
  const full = cases.length === 6 && cases.every((row) => row.a.length === 20);
  const sufficient =
    full &&
    [...aResults, ...bResults].every((row) => row?.setupFault !== true) &&
    summaries.every(
      ({ a, b }) =>
        a.counted === a.scheduled &&
        b.counted === b.scheduled &&
        a.raw !== null &&
        b.raw !== null &&
        a.polls !== null &&
        b.polls !== null,
    );
  const reliable = summaries.every(
    ({ a, b }) => b.correct >= a.correct && b.correct > b.scheduled / 2,
  );
  const zeroPolls = totals.b.polls === 0;
  const aRaw = completeMean(aResults, (row) => row.rawTokens);
  const bRaw = completeMean(bResults, (row) => row.rawTokens);
  const cheaper = aRaw !== null && bRaw !== null && bRaw < aRaw;
  return {
    outcome: !sufficient ? "incomplete" : reliable && zeroPolls && cheaper ? "pass" : "fail",
    heads: { a: a.config.head, b: b.config.head },
    formulaInputs: { typicalContext, subsequentTurns },
    summaries,
    totals,
    gates: { sufficient, reliable, zeroPolls, cheaper },
  };
}

if (import.meta.main) {
  const { positionals, values: flags } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      "subsequent-turns": { type: "string", default: "5" },
      "baseline-head": { type: "string" },
    },
  });
  const [left, right] = positionals;
  const subsequentTurns = Number(flags["subsequent-turns"]);
  if (
    positionals.length !== 2 ||
    left === undefined ||
    right === undefined ||
    !Number.isSafeInteger(subsequentTurns) ||
    subsequentTurns < 0
  ) {
    throw new Error(
      "Usage: node evals/background-wait/compare.ts <arm-a/results.json> <arm-b/results.json> [--subsequent-turns 5] [--baseline-head <exact-arm-a-head>]",
    );
  }
  const comparison = compare(load(left), load(right), subsequentTurns, flags["baseline-head"]);
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.outcome !== "pass") process.exitCode = 1;
}
