// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const workflow = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf8",
);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringValues = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringValues) : [];

const usesBlacksmithRunner = (value: unknown): boolean =>
  stringValues(value).some((entry) => entry.includes("blacksmith-"));

const hasBlacksmithRunnerConfiguration = (source: string): boolean => {
  const document: unknown = parse(source);
  const jobs = asRecord(asRecord(document)?.jobs);
  if (jobs === undefined) return false;

  for (const value of Object.values(jobs)) {
    const job = asRecord(value);
    if (job === undefined) continue;
    const runners = stringValues(job["runs-on"]);
    if (runners.some((runner) => runner.includes("blacksmith-"))) return true;

    const matrix = asRecord(asRecord(job.strategy)?.matrix);
    if (matrix === undefined) continue;
    for (const runner of runners) {
      for (const match of runner.matchAll(/\$\{\{\s*matrix\.(?<key>[A-Za-z_][\w-]*)\s*\}\}/gu)) {
        const key = match.groups?.key;
        if (key === undefined) continue;
        if (usesBlacksmithRunner(matrix[key])) return true;
        if (
          Array.isArray(matrix.include) &&
          matrix.include.some((entry) => usesBlacksmithRunner(asRecord(entry)?.[key]))
        ) {
          return true;
        }
      }
    }
  }
  return false;
};

const gateBlock = /^  ci_gate:\n(?<body>[\s\S]*)$/mu.exec(workflow)?.groups?.body;
if (!gateBlock) throw new Error("CI workflow is missing the ci_gate job.");

const gateScriptBody = /        run: \|\n(?<body>(?:          .*\n?)*)$/u.exec(gateBlock)?.groups
  ?.body;
if (!gateScriptBody) throw new Error("CI workflow is missing the CI Gate decision script.");

const gateScript = gateScriptBody
  .split("\n")
  .map((line) => line.replace(/^ {10}/u, ""))
  .join("\n");

const successfulGateEnvironment = {
  CHECK_RESULT: "success",
  TEST_RESULT: "success",
  TEST_SERVER_RESULT: "success",
  RUST_RESULT: "success",
  MOBILE_CHANGES_RESULT: "success",
  MOBILE_CHANGED: "false",
  MOBILE_STATIC_RESULT: "skipped",
  RELEASE_SMOKE_RESULT: "success",
};

const runGate = (overrides: Readonly<Record<string, string>> = {}): number | null =>
  NodeChildProcess.spawnSync("bash", ["-c", gateScript], {
    env: { ...process.env, ...successfulGateEnvironment, ...overrides },
    stdio: "ignore",
  }).status;

describe("LastCode GitHub CI workflow", () => {
  it("targets the downstream branch on standard GitHub runners", () => {
    expect(workflow).toContain(
      'run-name: "CI ${{ github.event_name }} PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }} base ${{ github.event.pull_request.base.sha }} merge ${{ github.sha }}"',
    );
    expect(workflow).toContain("pull_request:\n    branches:\n      - lastcode/main");
    expect(workflow).toContain("push:\n    branches:\n      - lastcode/main");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("fetch-depth: 2");
    expect(workflow).toContain('files="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA"');
    expect(hasBlacksmithRunnerConfiguration(workflow)).toBe(false);
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("runs-on: macos-26");
  });

  it("rejects direct and matrix Blacksmith runners without matching comments or mirror files", () => {
    expect(
      hasBlacksmithRunnerConfiguration(
        'jobs:\n  test:\n    runs-on: "blacksmith-8vcpu-ubuntu-2404"',
      ),
    ).toBe(true);
    expect(
      hasBlacksmithRunnerConfiguration(
        "jobs:\n  test:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [blacksmith-8vcpu-ubuntu-2404]",
      ),
    ).toBe(true);
    expect(
      hasBlacksmithRunnerConfiguration(
        "jobs:\n  test:\n    runs-on: ubuntu-24.04 # blacksmith-8vcpu-ubuntu-2404",
      ),
    ).toBe(false);
    expect(
      hasBlacksmithRunnerConfiguration(
        "jobs:\n  test:\n    name: don't migrate runners # blacksmith-8vcpu-ubuntu-2404\n    runs-on: ubuntu-24.04",
      ),
    ).toBe(false);
    expect(
      hasBlacksmithRunnerConfiguration(
        'jobs:\n  test:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include: [{ note: "keep\n          # temporarily", runner: blacksmith-8vcpu-ubuntu-2404 }]',
      ),
    ).toBe(true);
    expect(
      hasBlacksmithRunnerConfiguration(
        "jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: cat /etc/apt/blacksmith-cache.txt",
      ),
    ).toBe(false);
  });

  it("makes the stable gate depend on every validation job", () => {
    for (const job of [
      "check",
      "test",
      "test_server",
      "rust",
      "mobile_native_changes",
      "mobile_native_static_analysis",
      "release_smoke",
    ]) {
      expect(gateBlock).toContain(`      - ${job}`);
    }
    expect(gateBlock).toContain("name: CI Gate");
    expect(gateBlock).toContain("if: ${{ always() }}");
  });

  it("passes when mandatory jobs succeed and irrelevant mobile analysis is skipped", () => {
    expect(runGate()).toBe(0);
  });

  it("passes when required mobile analysis succeeds", () => {
    expect(runGate({ MOBILE_CHANGED: "true", MOBILE_STATIC_RESULT: "success" })).toBe(0);
  });

  it("fails closed for every unsuccessful mandatory result", () => {
    for (const variable of [
      "CHECK_RESULT",
      "TEST_RESULT",
      "TEST_SERVER_RESULT",
      "RUST_RESULT",
      "MOBILE_CHANGES_RESULT",
      "RELEASE_SMOKE_RESULT",
    ]) {
      expect(runGate({ [variable]: "failure" })).not.toBe(0);
      expect(runGate({ [variable]: "cancelled" })).not.toBe(0);
      expect(runGate({ [variable]: "skipped" })).not.toBe(0);
    }
  });

  it("accepts a skipped mobile job only after an explicit no-change result", () => {
    expect(runGate({ MOBILE_CHANGED: "", MOBILE_STATIC_RESULT: "skipped" })).not.toBe(0);
    expect(runGate({ MOBILE_CHANGED: "true", MOBILE_STATIC_RESULT: "skipped" })).not.toBe(0);
    expect(runGate({ MOBILE_CHANGED: "false", MOBILE_STATIC_RESULT: "success" })).not.toBe(0);
  });
});
