import { describe, expect, it } from "vite-plus/test";

import {
  assertGithubMergeProtection,
  assertStrictGithubCiGate,
  evaluateGithubCi,
  githubBranchRulesArgs,
  githubCiJobsArgs,
  githubCiRunTitle,
  githubCiRunsArgs,
  githubCiWorkflowArgs,
  readGithubCi,
  testedMergeShaFromGithubCiRunTitle,
  type GithubCiEvaluationInput,
} from "./lastcode-github-ci.ts";

const MERGE = "1234567890abcdef1234567890abcdef12345678";
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const BASE = "fedcba0987654321fedcba0987654321fedcba09";
const TITLE = `CI pull_request PR #104 head ${HEAD} base ${BASE} merge ${MERGE}`;

const input = (overrides: Partial<GithubCiEvaluationInput> = {}): GithubCiEvaluationInput => ({
  workflow: { id: 123, state: "active" },
  branchRules: [],
  pullRequestNumber: 104,
  headSha: HEAD,
  baseSha: BASE,
  workflowRuns: [
    {
      id: 456,
      display_title: TITLE,
      event: "pull_request",
      head_sha: HEAD,
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
  it("proves strict CI applies to the authenticated merge actor without assuming bypass membership", () => {
    const check = (bypassActors: unknown, enforcement = "active", actorId: unknown = 42) => {
      const responses: Record<string, unknown> = {
        "api user": { id: actorId },
        "api repos/example/repo/rules/branches/lastcode%2Fmain": [
          {
            type: "required_status_checks",
            ruleset_id: 7,
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: "CI Gate" }],
            },
          },
        ],
        "api repos/example/repo/rulesets/7": { enforcement, bypass_actors: bypassActors },
      };
      assertGithubMergeProtection(
        "example/repo",
        "lastcode/main",
        <T>(args: ReadonlyArray<string>): T => responses[args.join(" ")] as T,
      );
    };
    expect(() => check([])).not.toThrow();
    expect(() =>
      check([{ actor_type: "User", actor_id: 99, bypass_mode: "always" }]),
    ).not.toThrow();
    for (const bypass of [
      { actor_type: "User", actor_id: 42, bypass_mode: "always" },
      { actor_type: "User", actor_id: 42, bypass_mode: "pull_request" },
      { actor_type: "Team", actor_id: 99, bypass_mode: "always" },
      { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
      { actor_type: "Integration", actor_id: 99, bypass_mode: "always" },
      { actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" },
      { actor_type: "User", bypass_mode: "always" },
    ]) {
      expect(() => check([bypass])).toThrow("Cannot prove");
    }
    expect(() => check(undefined)).toThrow("Cannot prove");
    expect(() => check([], "evaluate")).toThrow("Cannot prove");
    expect(() => check([], "active", null)).toThrow("Cannot identify");
    expect(() => check([], "active", "42")).toThrow("Cannot identify");
  });

  it("requires the CI gate itself to enforce an up-to-date base at merge time", () => {
    const rule = {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "CI Gate" }],
      },
    };
    expect(() => assertStrictGithubCiGate([rule])).not.toThrow();
    for (const rules of [
      [],
      [{ ...rule, parameters: { required_status_checks: [{ context: "CI Gate" }] } }],
      [
        {
          ...rule,
          parameters: { ...rule.parameters, strict_required_status_checks_policy: false },
        },
      ],
      [
        {
          ...rule,
          parameters: { ...rule.parameters, required_status_checks: [{ context: "Other" }] },
        },
      ],
    ]) {
      expect(() => assertStrictGithubCiGate(rules)).toThrow("require branches to be up to date");
    }
  });

  it("builds exact workflow, rules, run, and job queries", () => {
    expect(githubCiWorkflowArgs("lastobelus/lastCode")).toEqual([
      "api",
      "repos/lastobelus/lastCode/actions/workflows/ci.yml",
    ]);
    expect(githubBranchRulesArgs("lastobelus/lastCode", "lastcode/main")).toEqual([
      "api",
      "repos/lastobelus/lastCode/rules/branches/lastcode%2Fmain",
    ]);
    expect(githubCiRunsArgs("lastobelus/lastCode", HEAD)).toEqual([
      "api",
      `repos/lastobelus/lastCode/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100`,
    ]);
    expect(
      githubCiRunTitle({ pullRequestNumber: 104, headSha: HEAD, baseSha: BASE, mergeSha: MERGE }),
    ).toBe(TITLE);
    expect(
      testedMergeShaFromGithubCiRunTitle(TITLE, {
        pullRequestNumber: 104,
        headSha: HEAD,
        baseSha: BASE,
      }),
    ).toBe(MERGE);
    expect(githubCiJobsArgs("lastobelus/lastCode", 456)).toEqual([
      "api",
      "repos/lastobelus/lastCode/actions/runs/456/jobs?filter=latest&per_page=100",
    ]);
  });

  it("reads workflow, rule, exact run, and aggregate job evidence through one shared path", () => {
    const calls: string[] = [];
    const responses = new Map<string, unknown>([
      [githubCiWorkflowArgs("lastobelus/lastCode").join(" "), { state: "active" }],
      [githubBranchRulesArgs("lastobelus/lastCode", "lastcode/main").join(" "), []],
      [
        githubCiRunsArgs("lastobelus/lastCode", HEAD).join(" "),
        { workflow_runs: input().workflowRuns },
      ],
      [githubCiJobsArgs("lastobelus/lastCode", 456).join(" "), { jobs: input().jobs }],
    ]);
    const evidence = readGithubCi(
      "lastobelus/lastCode",
      {
        number: 104,
        headRefOid: HEAD,
        baseRefOid: BASE,
        baseRefName: "lastcode/main",
      },
      <T>(args: ReadonlyArray<string>): T => {
        const key = args.join(" ");
        calls.push(key);
        return responses.get(key) as T;
      },
    );

    expect(evidence).toMatchObject({ state: "satisfied", reason: "exact-run", runId: 456 });
    expect(calls).toEqual([...responses.keys()]);
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

  it("waits for exact workflow registration", () => {
    expect(evaluateGithubCi(input({ workflowRuns: [], jobs: null }))).toEqual({
      state: "pending",
      reason: "run-registration",
    });
  });

  it("ignores runs for a different head or base", () => {
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 1,
              display_title: TITLE,
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
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 1,
              display_title: githubCiRunTitle({
                pullRequestNumber: 104,
                headSha: HEAD,
                baseSha: "b".repeat(40),
                mergeSha: MERGE,
              }),
              event: "pull_request",
              head_sha: HEAD,
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
      ),
    ).toEqual({ state: "pending", reason: "run-registration" });
  });

  it("retains the immutable tested merge SHA without comparing it to a later PR snapshot", () => {
    expect(evaluateGithubCi(input())).toMatchObject({
      state: "satisfied",
      testedMergeSha: MERGE,
    });
  });

  it("uses the newest exact run and waits while it is active", () => {
    expect(
      evaluateGithubCi(
        input({
          workflowRuns: [
            {
              id: 1,
              display_title: TITLE,
              event: "pull_request",
              head_sha: HEAD,
              status: "completed",
              conclusion: "success",
              created_at: "2026-08-27T09:00:00Z",
            },
            {
              id: 2,
              display_title: TITLE,
              event: "pull_request",
              head_sha: HEAD,
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
              display_title: TITLE,
              event: "pull_request",
              head_sha: HEAD,
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
        input({
          workflowRuns: [{ id: 1, display_title: TITLE, event: "pull_request", head_sha: HEAD }],
        }),
      ),
    ).toMatchObject({ state: "failure", reason: "configuration" });
  });
});
