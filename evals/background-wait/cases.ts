export type Arm = "a" | "b";

const upstream = "0123456789abcdef0123456789abcdef01234567";
const tag = "lastcode/revision/v0.0.1-nightly.20260101.10.1";
const source = "https://github.com/lastobelus/lastCode/issues/824";

export const cases = [
  {
    id: "prepare",
    source,
    actionId: "lc-prepare-dependencies",
    name: "Prepare Dependencies",
    wrapper: ["prepare"],
    script: "prepare-dependencies.ts",
    seconds: 8,
    exitCode: 0,
    request: "Prepare dependencies in this checkout so tests can run.",
  },
  {
    id: "prepare-checkpoint",
    source,
    actionId: "lc-prepare-checkpoint",
    name: "Prepare Checkpoint Dependencies",
    wrapper: ["prepare-checkpoint", "--upstream", upstream],
    script: "lastcode-regenerate-derived.ts",
    args: ["--upstream", upstream],
    seconds: 45,
    exitCode: 0,
    request: `Prepare the checkpoint replay's derived files and dependencies for upstream commit ${upstream}.`,
  },
  {
    id: "quick-ci",
    source,
    actionId: "lc-local-ci",
    name: "Run Quick CI",
    wrapper: ["ci", "--quick"],
    script: "lastcode-local-ci.ts",
    args: ["--quick"],
    seconds: 65,
    exitCode: 3,
    delegated: true,
    request: "Run Quick CI in the worker's own checkout and report the check result.",
  },
  {
    id: "wait-checkpoint",
    source,
    actionId: "lc-wait-for-checkpoint",
    name: "Wait for Checkpoint",
    wrapper: ["wait-checkpoint"],
    script: "lastcode-wait-for-checkpoint.ts",
    seconds: 120,
    exitCode: 0,
    request: "The checkpoint service is already running. Wait for its result and report it.",
  },
  {
    id: "package",
    source,
    actionId: "lc-build-local-package",
    name: "Build Local Package",
    wrapper: ["package", "--tag", tag],
    script: "lastcode-build-local-package.ts",
    args: ["run", "--tag", tag],
    seconds: 55,
    exitCode: 0,
    request: `Build the authorized local Apple Silicon package for ${tag}. Report the result and artifact path.`,
  },
  {
    id: "standing-watch",
    source,
    actionId: "lc-standing-watch",
    name: "Watch for Milestones",
    wrapper: ["wait-checkpoint"],
    script: "lastcode-wait-for-checkpoint.ts",
    seconds: 45,
    exitCode: 0,
    stages: 3,
    request:
      "Watch the milestone queue until it reports that it has drained. Process and acknowledge each batch of milestones using the project instructions, then relaunch the watch.",
  },
] satisfies ReadonlyArray<Scenario>;

export interface Scenario {
  id: string;
  source: string;
  actionId: string;
  name: string;
  wrapper: string[];
  script: string;
  args?: string[];
  seconds: number;
  exitCode: number;
  request: string;
  delegated?: boolean;
  stages?: number;
}

export function projectNotes(scenario: Scenario, arm: Arm): string {
  const operation =
    arm === "a"
      ? `Use this project's saved **${scenario.name}** Project Action. List Project Actions, run the eligible Action, and end the turn. Continue on its result.`
      : scenario.stages === undefined
        ? ""
        : "Milestone watch: run `./scripts/lc-run wait-checkpoint` for each batch.";
  const watch =
    scenario.stages === undefined
      ? ""
      : "For each batch, run `node scripts/ack.ts <first-milestone> <second-milestone>` with the IDs from the result in the order shown. Then start the same watch again. A drained queue ends the task.";
  return [operation, watch].filter(Boolean).join("\n");
}

export function taskPrompt(scenario: Scenario, arm: Arm, model: string, effort?: string): string {
  const task = `${scenario.request} In your final answer include “Result ID <id>” and “exit code <code>” from the result.`;
  if (!scenario.delegated) return task;
  const ownership =
    arm === "a"
      ? " Verify appOwnedActionContinuationVersion with orchestrator_capabilities. This isolated acceptance scenario authorizes the child to own its opted-in Action. State that authorization and the verified feature in its brief."
      : "";
  return `Delegate exactly one owned task using delegate_task in async mode with worktree isolation and the same provider and model (${model}${effort ? `, effort=${effort}` : ""}).${ownership} In the brief say: "You are the main agent of this LastCode worker thread. Do the work yourself in your own checkout. ${task}" Let the worker finish and report its final result to me.`;
}
