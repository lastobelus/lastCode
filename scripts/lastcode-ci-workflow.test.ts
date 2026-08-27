// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const workflow = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf8",
);

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
    expect(workflow).not.toContain("blacksmith-");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("runs-on: macos-26");
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
