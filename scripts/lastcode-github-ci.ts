export const LASTCODE_CI_WORKFLOW = "ci.yml";
export const LASTCODE_CI_GATE = "CI Gate";

export type GithubWorkflow = {
  readonly id?: number;
  readonly path?: string;
  readonly state?: string;
};

export type GithubBranchRule = {
  readonly type?: string;
  readonly parameters?: {
    readonly required_status_checks?: ReadonlyArray<{
      readonly context?: string;
    }>;
  };
};

export type GithubWorkflowRun = {
  readonly id?: number;
  readonly display_title?: string;
  readonly event?: string;
  readonly head_sha?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly run_attempt?: number;
  readonly html_url?: string;
};

export type GithubWorkflowJob = {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
};

export type GithubCiEvidence =
  | {
      readonly state: "satisfied";
      readonly reason: "exact-run" | "not-expected";
      readonly runId?: number;
      readonly runUrl?: string;
    }
  | {
      readonly state: "pending";
      readonly reason: "merge-recomputing" | "run-in-progress" | "run-registration";
      readonly runId?: number;
      readonly runUrl?: string;
    }
  | {
      readonly state: "failure";
      readonly reason: "aggregate-gate" | "configuration" | "terminal-run";
      readonly detail: string;
      readonly runId?: number;
      readonly runUrl?: string;
    };

export interface GithubCiEvaluationInput {
  readonly workflow: GithubWorkflow;
  readonly branchRules: ReadonlyArray<GithubBranchRule>;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeSha: string | null;
  readonly workflowRuns: ReadonlyArray<GithubWorkflowRun>;
  readonly jobs: ReadonlyArray<GithubWorkflowJob> | null;
}

const runTimestamp = (run: GithubWorkflowRun): number => {
  const parsed = Date.parse(run.created_at ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
};

export function githubCiWorkflowArgs(repository: string): ReadonlyArray<string> {
  return ["api", `repos/${repository}/actions/workflows/${LASTCODE_CI_WORKFLOW}`];
}

export function githubBranchRulesArgs(
  repository: string,
  baseBranch: string,
): ReadonlyArray<string> {
  return ["api", `repos/${repository}/rules/branches/${encodeURIComponent(baseBranch)}`];
}

export function githubCiRunsArgs(repository: string, headSha: string): ReadonlyArray<string> {
  return [
    "api",
    `repos/${repository}/actions/workflows/${LASTCODE_CI_WORKFLOW}/runs?event=pull_request&head_sha=${headSha}&per_page=100`,
  ];
}

export function githubCiRunTitle(input: {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeSha: string;
}): string {
  return `CI pull_request PR #${input.pullRequestNumber} head ${input.headSha} base ${input.baseSha} merge ${input.mergeSha}`;
}

export function githubCiJobsArgs(repository: string, runId: number): ReadonlyArray<string> {
  return ["api", `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`];
}

export function requiredGithubCiGate(branchRules: ReadonlyArray<GithubBranchRule>): boolean {
  return branchRules.some(
    (rule) =>
      rule.type === "required_status_checks" &&
      rule.parameters?.required_status_checks?.some(({ context }) => context === LASTCODE_CI_GATE),
  );
}

const configurationFailure = (detail: string): GithubCiEvidence => ({
  state: "failure",
  reason: "configuration",
  detail,
});

const disabledWorkflowStates = new Set([
  "disabled_fork",
  "disabled_inactivity",
  "disabled_manually",
]);

export function evaluateGithubCi(input: GithubCiEvaluationInput): GithubCiEvidence {
  const required = requiredGithubCiGate(input.branchRules);
  const workflowActive = input.workflow.state === "active";
  const workflowDisabled = disabledWorkflowStates.has(input.workflow.state ?? "");

  if (!workflowActive && !workflowDisabled) {
    return configurationFailure(
      `Workflow ${LASTCODE_CI_WORKFLOW} has unsupported state ${input.workflow.state ?? "missing"}.`,
    );
  }
  if (workflowDisabled && required) {
    return configurationFailure(
      `Required check ${LASTCODE_CI_GATE} cannot run while ${LASTCODE_CI_WORKFLOW} is disabled.`,
    );
  }
  if (!workflowActive) return { state: "satisfied", reason: "not-expected" };
  if (!input.mergeSha) return { state: "pending", reason: "merge-recomputing" };

  const expectedTitle = githubCiRunTitle({
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    mergeSha: input.mergeSha,
  });

  const exactRuns = input.workflowRuns
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.head_sha === input.headSha &&
        run.display_title === expectedTitle &&
        run.id !== undefined,
    )
    .sort(
      (left, right) => runTimestamp(right) - runTimestamp(left) || (right.id ?? 0) - (left.id ?? 0),
    );
  const run = exactRuns[0];
  if (!run) return { state: "pending", reason: "run-registration" };

  const runId = run.id;
  if (runId === undefined) return configurationFailure("Exact workflow run has no ID.");
  const runIdentity = run.html_url ? { runId, runUrl: run.html_url } : { runId };
  if (run.status !== "completed") {
    if (["queued", "in_progress", "pending", "requested", "waiting"].includes(run.status ?? "")) {
      return { state: "pending", reason: "run-in-progress", ...runIdentity };
    }
    return {
      state: "failure",
      reason: "configuration",
      detail: `Workflow run ${runId} has unsupported status ${run.status ?? "missing"}.`,
      ...runIdentity,
    };
  }
  if (run.conclusion !== "success") {
    return {
      state: "failure",
      reason: "terminal-run",
      detail: `Workflow run ${runId} completed with ${run.conclusion ?? "no conclusion"}.`,
      ...runIdentity,
    };
  }

  const gates = (input.jobs ?? []).filter(({ name }) => name === LASTCODE_CI_GATE);
  if (gates.length !== 1) {
    return {
      state: "failure",
      reason: "configuration",
      detail: `Workflow run ${runId} reported ${gates.length} ${LASTCODE_CI_GATE} jobs.`,
      ...runIdentity,
    };
  }
  const gate = gates[0];
  if (gate?.status !== "completed") {
    return {
      state: "failure",
      reason: "configuration",
      detail: `${LASTCODE_CI_GATE} did not complete with its workflow run.`,
      ...runIdentity,
    };
  }
  if (gate.conclusion !== "success") {
    return {
      state: "failure",
      reason: "aggregate-gate",
      detail: `${LASTCODE_CI_GATE} completed with ${gate.conclusion ?? "no conclusion"}.`,
      ...runIdentity,
    };
  }
  return { state: "satisfied", reason: "exact-run", ...runIdentity };
}
