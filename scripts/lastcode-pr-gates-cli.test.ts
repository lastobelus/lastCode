// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "lastcode-pr-gates.ts");
const repository = "example/stack-project";
const head = "a".repeat(40);
const parentHead = "b".repeat(40);
const base = "c".repeat(40);
const merge = "d".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function pullRequest(number: number, stacked = false) {
  return {
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: `lastcode/pr-${number}`,
    headRefOid: number === 302 ? head : parentHead,
    headRepository: { nameWithOwner: repository, name: "stack-project" },
    isCrossRepository: false,
    baseRefName: stacked ? "lastcode/pr-301" : "lastcode/main",
    baseRefOid: stacked ? parentHead : base,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    potentialMergeCommit: { oid: merge },
  };
}

// Exercise the real CLI with the installed gh JSON shape and deterministic
// terminal gates. No hosted jobs, network requests, or polling sleeps are used.
const fakeGithub = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.GATES_TEST_STATE, "utf8"));
const selected = state.pullRequests.find(pr => pr.number === 302);
let result;
if (args[0] === "pr" && args[1] === "view") {
  result = state.pullRequests.find(pr => String(pr.number) === args[2] || pr.headRefName === args[2]);
  if (!result) throw new Error("Unknown mock PR " + args[2]);
} else if (args[0] === "pr" && args[1] === "list") {
  const branch = args[args.indexOf("--head") + 1];
  result = state.pullRequests.filter(pr => pr.headRefName === branch && pr.state === "OPEN");
} else if (args.includes("graphql")) {
  result = [{data:{repository:{pullRequest:{reviewThreads:{nodes:state.unresolved ? [{id:"thread1",isResolved:false}] : [],pageInfo:{hasNextPage:false,endCursor:null}}}}}}];
} else {
  const endpoint = args.find(arg => arg.startsWith("repos/"));
  if (endpoint?.endsWith("/actions/workflows/ci.yml")) {
    result = {id: 7, state: state.workflowState || "active"};
    if (state.driftDuringObservation) {
      const parent = state.pullRequests.find(pr => pr.number === 301);
      parent.baseRefOid = "e".repeat(40);
      state.driftDuringObservation = false;
      fs.writeFileSync(process.env.GATES_TEST_STATE, JSON.stringify(state));
    }
  } else if (endpoint?.includes("/rules/branches/")) {
    result = [];
  } else if (endpoint?.includes("/actions/workflows/ci.yml/runs?")) {
    result = {workflow_runs:state.ciConclusion === "missing" ? [] : [{id:9,event:"pull_request",head_sha:selected.headRefOid,
      display_title:"CI pull_request PR #302 head " + selected.headRefOid + " base " + (state.ciRunBase || selected.baseRefOid) + " merge ${merge}",
      status:state.ciConclusion === "pending" ? "in_progress" : "completed",conclusion:state.ciConclusion || "success",created_at:"2026-09-01T12:00:00Z"}]};
  } else if (endpoint?.includes("/actions/runs/9/jobs?")) {
    result = {jobs:[{name:"CI Gate",status:"completed",conclusion:"success"}]};
  } else if (endpoint?.includes("/pulls/302/reviews?")) {
    state.reviewReads = (state.reviewReads || 0) + 1;
    fs.writeFileSync(process.env.GATES_TEST_STATE, JSON.stringify(state));
    result = state.reviewMode === "pending" ? [[]] : [[{id:state.changeReviewOnConfirmation ? state.reviewReads : 10,user:{login:"chatgpt-codex-connector[bot]"},state:state.reviewMode === "finding" ? "CHANGES_REQUESTED" : "APPROVED",
      commit_id:selected.headRefOid,submitted_at:"2026-09-01T12:05:00Z",body:""}]];
  } else if (endpoint?.includes("/issues/302/comments?")) {
    result = [[{id:40,user:{login:"maintainer"},author_association:"OWNER",
      body:"@codex review\\n<!-- lastcode-review-head: " + selected.headRefOid + " -->",
      created_at:"2026-09-01T12:00:00Z"}]];
  } else if (endpoint?.includes("/reactions?")) {
    result = [[]];
  } else if (endpoint?.includes("/comments?")) {
    result = [[]];
  } else {
    throw new Error("Unhandled mock gh call " + JSON.stringify(args));
  }
}
process.stdout.write(JSON.stringify(result));
`;

function fixture(stacked = false) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-pr-gates-cli-"));
  temporaryDirectories.push(root);
  const cwd = NodePath.join(root, "checkout");
  const bin = NodePath.join(root, "bin");
  const statePath = NodePath.join(root, "github.json");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "gh"), fakeGithub, { mode: 0o755 });
  const state = {
    pullRequests: [pullRequest(302, stacked), ...(stacked ? [pullRequest(301)] : [])],
    workflowState: "active",
    ciConclusion: "success",
    ciRunBase: null as string | null,
    driftDuringObservation: false,
    reviewMode: "clean",
    changeReviewOnConfirmation: false,
    unresolved: false,
  };
  const save = () => NodeFS.writeFileSync(statePath, JSON.stringify(state));
  save();
  const git = (...args: string[]) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "lastcode/coordinator");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const runFrom = (workingDirectory: string, ...args: string[]) =>
    NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        LASTCODE_GITHUB_REPOSITORY: repository,
        GATES_TEST_STATE: statePath,
      },
      encoding: "utf8",
      timeout: 15_000,
    });

  const run = (...args: string[]) => runFrom(cwd, ...args);
  return { cwd, state, save, run, runFrom, git };
}

describe("one-shot PR gates CLI", () => {
  it("checks an explicit canonical PR from an unrelated dirty checkout without Action output or pin files", () => {
    const test = fixture();
    NodeFS.writeFileSync(NodePath.join(test.cwd, "unrelated.txt"), "preserve me");
    const result = test.run("--pr", "302");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      pr: 302,
      head,
      parents: [],
    });
    expect(result.stdout).not.toContain("lastcode-action");
    expect(NodeFS.existsSync(NodePath.join(test.cwd, ".git", "lastcode"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(test.cwd, "unrelated.txt"), "utf8")).toBe(
      "preserve me",
    );
  });
  it("checks a live parent chain without saving a target", () => {
    const test = fixture(true);
    const result = test.run("--pr", "302");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "stacked-ready",
      parents: [{ number: 301, headRefOid: parentHead }],
    });
  });
  it("returns pending immediately when review or CI is incomplete", () => {
    const test = fixture();
    test.state.reviewMode = "pending";
    test.save();
    const pending = test.run("--pr", "302");
    expect(pending.status, pending.stdout).toBe(0);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      status: "pending",
      reason: "review-pending",
    });
    test.state.reviewMode = "clean";
    test.state.ciConclusion = "pending";
    test.save();
    const ci = test.run("--pr", "302");
    expect(ci.status, ci.stdout).toBe(0);
    expect(JSON.parse(ci.stdout)).toMatchObject({ status: "pending", reason: "ci-pending" });
  });
  it("hands a missing CI run to the watch only while review is pending", () => {
    const test = fixture();
    test.state.ciConclusion = "missing";
    test.state.reviewMode = "pending";
    test.save();
    const pending = test.run("--pr", "302");
    expect(pending.status, pending.stdout).toBe(0);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      status: "pending",
      reason: "ci-registration",
    });
    test.state.reviewMode = "clean";
    test.save();
    const missing = test.run("--pr", "302");
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: "attention",
      reason: "ci-not-registered",
    });
    test.state.ciConclusion = "success";
    test.state.ciRunBase = "e".repeat(40);
    test.save();
    const staleBase = test.run("--pr", "302");
    expect(staleBase.status).toBe(1);
    expect(JSON.parse(staleBase.stdout)).toMatchObject({
      status: "attention",
      reason: "ci-not-registered",
    });
  });
  it("reports CI failure even while review is pending", () => {
    const test = fixture();
    test.state.ciConclusion = "failure";
    test.state.reviewMode = "pending";
    test.save();
    const result = test.run("--pr", "302");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "attention", reason: "ci-failed" });
  });
  it("rejects unresolved threads and disabled CI", () => {
    const test = fixture();
    test.state.unresolved = true;
    test.save();
    expect(JSON.parse(test.run("--pr", "302").stdout)).toMatchObject({
      status: "attention",
      reason: "review-unresolved",
    });
    test.state.unresolved = false;
    test.state.workflowState = "disabled_manually";
    test.save();
    expect(JSON.parse(test.run("--pr", "302").stdout)).toMatchObject({
      status: "attention",
      reason: "ci-configuration",
    });
  });
  it("fails closed when a parent moves during collection", () => {
    const test = fixture(true);
    test.state.driftDuringObservation = true;
    test.save();
    const result = test.run("--pr", "302");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "attention",
      reason: "observation-failed",
      detail: expect.stringContaining("changed during"),
    });
  });
  it("requires a matching clean local HEAD without an explicit PR", () => {
    const test = fixture();
    test.git("checkout", "-b", "lastcode/pr-302");
    test.state.pullRequests[0]!.headRefOid = test.git("rev-parse", "HEAD");
    test.save();
    const clean = test.run();
    expect(clean.status, clean.stdout).toBe(0);
    expect(JSON.parse(clean.stdout).status).toBe("ready");
    NodeFS.writeFileSync(NodePath.join(test.cwd, "untracked.txt"), "dirty");
    const dirty = test.run();
    expect(dirty.status).toBe(1);
    expect(JSON.parse(dirty.stdout)).toMatchObject({
      status: "attention",
      reason: "worktree-changed",
    });
  });
  it("requires stable review evidence before reporting readiness", () => {
    const test = fixture();
    test.state.changeReviewOnConfirmation = true;
    test.save();
    const result = test.run("--pr", "302");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "attention",
      detail: expect.stringContaining("Review evidence changed"),
    });
  });
  it("rejects the retired target-selection CLI", () => {
    const test = fixture();
    const result = test.run("--target", "302");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).detail).toContain("Usage:");
  });
});
