// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "lastcode-wait-for-pr.ts");
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
const state = JSON.parse(fs.readFileSync(process.env.WAIT_TEST_STATE, "utf8"));
const selected = state.pullRequests.find(pr => pr.number === 302);
let result;
if (args[0] === "pr" && args[1] === "view") {
  result = state.pullRequests.find(pr => String(pr.number) === args[2] || pr.headRefName === args[2]);
  if (!result) throw new Error("Unknown mock PR " + args[2]);
} else if (args[0] === "pr" && args[1] === "list") {
  const branch = args[args.indexOf("--head") + 1];
  result = state.pullRequests.filter(pr => pr.headRefName === branch && pr.state === "OPEN");
} else if (args.includes("graphql")) {
  result = [{data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}}];
} else {
  const endpoint = args.find(arg => arg.startsWith("repos/"));
  if (endpoint?.endsWith("/actions/workflows/ci.yml")) {
    result = {id: 7, state: state.workflowState || "active"};
    if (state.driftDuringObservation) {
      const parent = state.pullRequests.find(pr => pr.number === 301);
      parent.baseRefOid = "e".repeat(40);
      state.driftDuringObservation = false;
      fs.writeFileSync(process.env.WAIT_TEST_STATE, JSON.stringify(state));
    }
  } else if (endpoint?.includes("/rules/branches/")) {
    result = [];
  } else if (endpoint?.includes("/actions/workflows/ci.yml/runs?")) {
    result = {workflow_runs:[{id:9,event:"pull_request",head_sha:selected.headRefOid,
      display_title:"CI pull_request PR #302 head " + selected.headRefOid + " base " + selected.baseRefOid + " merge ${merge}",
      status:"completed",conclusion:state.ciConclusion || "success",created_at:"2026-09-01T12:00:00Z"}]};
  } else if (endpoint?.includes("/actions/runs/9/jobs?")) {
    result = {jobs:[{name:"CI Gate",status:"completed",conclusion:"success"}]};
  } else if (endpoint?.includes("/pulls/302/reviews?")) {
    result = [[{id:10,user:{login:"chatgpt-codex-connector[bot]"},state:"APPROVED",
      commit_id:selected.headRefOid,submitted_at:"2026-09-01T12:05:00Z",body:""}]];
  } else if (endpoint?.includes("/comments?")) {
    result = [[]];
  } else {
    throw new Error("Unhandled mock gh call " + JSON.stringify(args));
  }
}
process.stdout.write(JSON.stringify(result));
`;

function fixture(stacked = false) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-wait-cli-"));
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
    driftDuringObservation: false,
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
        WAIT_TEST_STATE: statePath,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
  const targetPath = NodePath.join(cwd, ".git", "lastcode", "wait-for-pr-target.json");
  const run = (...args: string[]) => runFrom(cwd, ...args);
  return { cwd, state, save, run, runFrom, git, targetPath };
}

describe("Wait for PR CLI selection", () => {
  it("keeps selections separate between linked worktrees", () => {
    const test = fixture();
    expect(test.run("--target", "302").status).toBe(0);
    const sibling = NodePath.join(NodePath.dirname(test.cwd), "sibling");
    test.git("worktree", "add", "--detach", sibling, "HEAD");
    expect(test.runFrom(sibling, "--clear-target").status).toBe(0);
    expect(NodeFS.existsSync(test.targetPath)).toBe(true);
    const result = test.runFrom(sibling);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checked-out branch");
  });

  it("observes an explicit canonical PR from an unrelated dirty checkout and clears selection", () => {
    const test = fixture();
    NodeFS.writeFileSync(NodePath.join(test.cwd, "unrelated.txt"), "preserve me");
    const selected = test.run("--target", "302");
    expect(selected.status, selected.stderr).toBe(0);
    expect(NodeFS.existsSync(test.targetPath)).toBe(true);
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"reason":"ready"');
    expect(result.stdout).toContain('"pr":302');
    expect(result.stdout).toContain(head);
    expect(NodeFS.readFileSync(NodePath.join(test.cwd, "unrelated.txt"), "utf8")).toBe(
      "preserve me",
    );
    expect(test.run("--clear-target").status).toBe(0);
    expect(test.run("--clear-target").status).toBe(0);
    expect(NodeFS.existsSync(test.targetPath)).toBe(false);
    expect(test.run().status).not.toBe(0);
  });

  it("reports stack validation separately from final merge readiness", () => {
    const test = fixture(true);
    expect(test.run("--target", "302").status).toBe(0);
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"reason":"stacked-ready"');
    expect(result.stdout).not.toContain('"reason":"ready"');
  });

  it("rejects a malformed selection instead of reverting to branch discovery", () => {
    const test = fixture();
    NodeFS.mkdirSync(NodePath.dirname(test.targetPath), { recursive: true });
    NodeFS.writeFileSync(test.targetPath, "{broken");
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("target file");
    expect(result.stdout).not.toContain('"reason":"ready"');
  });

  it("rejects drift between target preparation and Action launch", () => {
    const test = fixture(true);
    expect(test.run("--target", "302").status).toBe(0);
    test.state.pullRequests[0]!.headRefOid = "f".repeat(40);
    test.save();
    const result = test.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stale");
  });

  it("catches ancestor drift during the final CI/review observation", () => {
    const test = fixture(true);
    expect(test.run("--target", "302").status).toBe(0);
    test.state.driftDuringObservation = true;
    test.save();
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"reason":"parent-drift"');
    expect(result.stdout).not.toContain('"reason":"stacked-ready"');
  });

  it.each(["disabled_manually", "disabled_fork"])(
    "never reports %s CI as explicit-target success",
    (workflowState) => {
      const test = fixture(true);
      expect(test.run("--target", "302").status).toBe(0);
      test.state.workflowState = workflowState;
      test.save();
      const result = test.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"reason":"ci-configuration"');
      expect(result.stdout).not.toContain('"reason":"stacked-ready"');
    },
  );

  it("reports failed exact CI even when no branch protection requires it", () => {
    const test = fixture(true);
    expect(test.run("--target", "302").status).toBe(0);
    test.state.ciConclusion = "failure";
    test.save();
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"reason":"ci-failed"');
  });
});
