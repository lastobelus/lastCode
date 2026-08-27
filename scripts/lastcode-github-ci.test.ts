import { describe, expect, it } from "vite-plus/test";

import {
  evaluateGithubCi,
  githubBranchRulesArgs,
  githubCiJobsArgs,
  githubCiRunsArgs,
  githubCiWorkflowArgs,
  type GithubCiEvaluationInput,
} from "./lastcode-github-ci.ts";

const MERGE = "1234567890abcdef1234567890abcdef12345678";

const input = (overrides: Partial<GithubCiEvaluationInput> = {}): GithubCiEvaluationInput => ({
  workflow: { id: 123, state: "active" },
  branchRules: [],
  mergeSha: MERGE,
  workflowRuns: [
    {
      id: 456,
      event: "pull_request",
      head_sha: MERGE,
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-27T10:00:00Z",
      html_url: "https://github.com/lastobelus/lastCode/actions/runs/456",
    },
  ],
  jobs: [{ name: "CI Gate", status: "completed", conclusion: "success" }],
  ...overrides,
});

describe("LastCode GitHub CI evidence", () => {
  it("builds exact workflow, rules, run, and job queries", () => {
    expect(githubCiWorkflowArgs("lastobelus/lastCode")).toEqual([
      "api",
      "repos/lastobelus/lastCode/actions/workflows/ci.yml",
    ]);
    expect(githubBranchRulesArgs("lastobelus/lastCode", "lastcode/main")).toEqual([
      "api",
      "repos/lastobelus/lastCode/rules/branches/lastcode%2Fmain",
    ]);
    expect(githubCiRunsArgs("lastobelus/lastCode", MERGE)).toEqual([
      "api",
      `repos/lastobelus/lastCode/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${MERGE}&per_page=100`,
    ]);
    expect(githubCiJobsArgs("lastobelus/lastCode", 456)).toEqual([
      "api",
      "repos/lastobelus/lastCode/actions/runs/456/jobs?filter=latest&per_page=100",
    ]);
  });

  it("satisfies disabled, non-required hosted CI without a run", () => {
    for (const state of ["disabled_fork", "disabled_inactivity", "disabled_manually"]) {
      expect(
        evaluateGithubCi(input({ workflow: { state }, workflowRuns: [], jobs: null })),
      ).toEqual({ state: "satisfied", reason: "not-expected" });
    }
  });

  it("fails closed when a required gate belongs to a disabled workflow", () => {
    expect(
      evaluateGithubCi(
        input({
          workflow: { state: "disabled_manually" },
          branchRules: [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI Gate" }] },
            },
          ],
          workflowRuns: [],
          jobs: null,
        }),
      ),
    ).toMatchObject({ state: "failure", reason: "configuration" });
  });

  it("waits for a merge revision and exact workflow registration", () => {
    expect(evaluateGithubCi(input({ mergeSha: null, workflowRuns: [], jobs: null }))).toEqual({
      state: "pending",
      reason: "merge-recomputing",
    });
    expect(evaluateGithubCi(input({ workflowRuns: [], jobs: null }))).toEqual({
      state: "pending",
      reason: "run-registration",
    });
  });

  it("ignores runs for a PR head or stale merge revision", () => {
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 1,
              event: "pull_request",
              head_sha: "a".repeat(40),
              status: "completed",
              conclusion: "success",
            },
          ],
          jobs: [{ name: "CI Gate", status: "completed", conclusion: "success" }],
        }),
      ),
    ).toEqual({ state: "pending", reason: "run-registration" });
  });

  it("uses the newest exact run and waits while it is active", () => {
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 1,
              event: "pull_request",
              head_sha: MERGE,
              status: "completed",
              conclusion: "success",
              created_at: "2026-08-27T09:00:00Z",
            },
            {
              id: 2,
              event: "pull_request",
              head_sha: MERGE,
              status: "in_progress",
              conclusion: null,
              created_at: "2026-08-27T10:00:00Z",
            },
          ],
          jobs: null,
        }),
      ),
    ).toMatchObject({ state: "pending", reason: "run-in-progress", runId: 2 });
  });

  it("reports terminal workflow failures without accepting an older success", () => {
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 2,
              event: "pull_request",
              head_sha: MERGE,
              status: "completed",
              conclusion: "cancelled",
              created_at: "2026-08-27T10:00:00Z",
            },
          ],
          jobs: null,
        }),
      ),
    ).toMatchObject({ state: "failure", reason: "terminal-run", runId: 2 });
  });

  it("requires one successful aggregate gate on a successful exact run", () => {
    expect(evaluateGithubCi(input())).toMatchObject({
      state: "satisfied",
      reason: "exact-run",
      runId: 456,
    });
    for (const conclusion of ["failure", "cancelled", "neutral", "skipped"] as const) {
      expect(
        evaluateGithubCi(input({ jobs: [{ name: "CI Gate", status: "completed", conclusion }] })),
      ).toMatchObject({ state: "failure", reason: "aggregate-gate" });
    }
    expect(evaluateGithubCi(input({ jobs: [] }))).toMatchObject({
      state: "failure",
      reason: "configuration",
    });
  });

  it("fails closed for unknown workflow and run states", () => {
    expect(evaluateGithubCi(input({ workflow: { state: "unknown" } }))).toMatchObject({
      state: "failure",
      reason: "configuration",
    });
    expect(
      evaluateGithubCi(
        input({ workflowRuns: [{ id: 1, event: "pull_request", head_sha: MERGE }] }),
      ),
    ).toMatchObject({ state: "failure", reason: "configuration" });
  });
});
