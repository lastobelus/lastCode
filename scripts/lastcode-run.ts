#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Starts before the checkout's dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type { ActionReport } from "@t3tools/contracts";
import {
  LASTCODE_BACKGROUND_WAIT_ENV,
  parseLastCodeWrappedAction,
  type LastCodeWrappedAction,
} from "../packages/shared/src/lastcodeWrappedCommands.ts";

const WAIT_INSTRUCTION =
  "[lc-run] If the shell reports this command is running in the background, end your turn. LastCode will wake you with the result. Do not poll.";
const USAGE =
  "Usage: ./scripts/lc-run prepare | prepare-checkpoint --upstream <commit> | ci --quick | ci --full | wait-checkpoint | package --tag <tag>";
const REPORT_PREFIX = "[lastcode-action] Result: ";

type Step = readonly [script: string, ...args: string[]];

function steps(action: LastCodeWrappedAction): readonly Step[] {
  switch (action.kind) {
    case "prepare":
      return [["prepare-dependencies.ts"]];
    case "prepare-checkpoint":
      return [["lastcode-regenerate-derived.ts", "--upstream", action.upstream]];
    case "ci":
      return [
        ["prepare-dependencies.ts", "--for-ci"],
        ["lastcode-local-ci.ts", action.mode],
      ];
    case "wait-checkpoint":
      return [["lastcode-wait-for-checkpoint.ts"]];
    case "package":
      return [["lastcode-build-local-package.ts", "run", "--tag", action.tag]];
  }
}

type StepResult = {
  readonly exitCode: number;
  readonly report?: ActionReport;
  readonly error?: string;
};

function readReport(line: string): ActionReport | undefined {
  if (!line.startsWith(REPORT_PREFIX)) return undefined;
  try {
    const report = JSON.parse(line.slice(REPORT_PREFIX.length)) as ActionReport;
    if (
      report?.version === 1 &&
      typeof report.summary === "string" &&
      ["success", "attention", "blocked"].includes(report.outcome)
    )
      return report;
  } catch {
    // Child output that is not an Action report is ordinary terminal output.
  }
  return undefined;
}

function compact(value: string, bytes: number): string {
  const text = value.replace(/\p{C}/gu, " ").replace(/\s+/gu, " ").trim();
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  return (
    buffer
      .subarray(0, bytes - 3)
      .toString()
      .replace(/\uFFFD$/u, "") + "..."
  );
}

function formatResult(action: LastCodeWrappedAction["kind"], result: StepResult): string {
  const { exitCode, report, error } = result;
  const outcome = report?.outcome ?? (exitCode === 0 ? "success" : "attention");
  const summary = report?.summary ?? error ?? (exitCode === 0 ? "Completed." : "Command failed.");
  const reason = report?.reason;
  const detail = report?.facts?.dmgPath ?? report?.facts?.reportPath ?? report?.facts?.diagnostic;
  return [
    `[lc-run] ${action}: ${outcome} (exit ${exitCode})${typeof reason === "string" ? ` [${compact(reason, 64)}]` : ""}`,
    compact(summary, 320),
    ...(typeof detail === "string" ? [compact(detail, 400)] : []),
    "",
  ].join("\n");
}

async function runStep(
  step: Step,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<StepResult> {
  const [script, ...args] = step;
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(directory, script), ...args],
    {
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const output = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let report: ActionReport | undefined;
  output.on("line", (line) => {
    const parsed = readReport(line);
    if (parsed !== undefined) report = parsed;
    else process.stdout.write(`${line}\n`);
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await new Promise<StepResult>((resolve) => {
      let error: string | undefined;
      child.once("error", (cause) => {
        error = cause.message;
      });
      child.once("close", (code, signal) =>
        resolve({
          exitCode: code ?? (signal === null ? 1 : 128 + NodeOS.constants.signals[signal]),
          ...(report === undefined ? {} : { report }),
          ...(error === undefined ? {} : { error }),
        }),
      );
    });
  } finally {
    output.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  const action = parseLastCodeWrappedAction(process.argv.slice(2));
  if (action === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    if (process.env[LASTCODE_BACKGROUND_WAIT_ENV] === "1") {
      process.stdout.write(`${WAIT_INSTRUCTION}\n`);
    }
    const environment = { ...process.env };
    // Read the scripts' ordinary text reports without emitting resumable Action protocol frames.
    delete environment.T3CODE_ACTION_RUN_ID;
    delete environment.T3CODE_ACTION_EVENT_TOKEN;
    let result: StepResult = { exitCode: 0 };
    for (const step of steps(action)) {
      result = await runStep(step, import.meta.dirname, environment);
      if (
        result.exitCode !== 0 ||
        (result.report !== undefined && result.report.outcome !== "success")
      )
        break;
    }
    process.stdout.write(formatResult(action.kind, result));
    process.exitCode = result.exitCode;
  }
}
