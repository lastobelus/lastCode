// @effect-diagnostics nodeBuiltinImport:off -- Exercise the standalone launcher without dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, onTestFinished } from "vite-plus/test";

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-run-"));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true }));
  const repo = NodePath.join(import.meta.dirname, "..");
  const script = "scripts/lastcode-run.ts";
  for (const file of [script, "packages/shared/src/lastcodeWrappedCommands.ts"]) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(repo, file), NodePath.join(root, file));
  }

  function writeStep(name: string, body: string) {
    NodeFS.writeFileSync(NodePath.join(root, "scripts", name), body);
  }
  function run(args: string[], backgroundWait: boolean) {
    return NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LASTCODE_BACKGROUND_WAIT: backgroundWait ? "1" : "0",
        T3CODE_ACTION_RUN_ID: "should-not-reach-script",
        T3CODE_ACTION_EVENT_TOKEN: "should-not-reach-script",
      },
    });
  }
  return { writeStep, run };
}

it("prints background guidance before the first step only in opted-in sessions", () => {
  const { writeStep, run } = fixture();
  writeStep(
    "prepare-dependencies.ts",
    `
    if (process.env.T3CODE_ACTION_RUN_ID || process.env.T3CODE_ACTION_EVENT_TOKEN) process.exit(99);
    console.log("Installing");
    console.log('[lastcode-action] Result: {"version":1,"outcome":"success","summary":"Installed"}');
  `,
  );
  const fast = run(["prepare"], false);
  const hinted = run(["prepare"], true);
  expect(fast.status).toBe(0);
  expect(fast.stdout).toBe("Installing\n[lc-run] prepare: success (exit 0)\nInstalled\n");
  expect(hinted.status).toBe(0);
  expect(hinted.stdout).toBe(
    "[lc-run] If you're this thread's main agent and the shell backgrounds a simple ./scripts/lc-run command, LastCode already registered the wake. End your turn without calling a tool. A literal cd <path> && prefix is fine without options or expansion. For other shell constructs or native subagents, collect the result.\n" +
      fast.stdout,
  );
});

it("preserves an attention result and keeps the whole summary within the wake's output tail", () => {
  const { writeStep, run } = fixture();
  writeStep(
    "lastcode-build-local-package.ts",
    `
    const [command, option, tag] = process.argv.slice(2);
    if (command !== "run" || option !== "--tag" || !tag.startsWith("lastcode/checkpoint/")) process.exit(98);
    console.log("large output".repeat(2000));
    console.log("[lastcode-action] Result: " + JSON.stringify({
      version: 1, outcome: "attention", reason: "build-failed",
      summary: "Build failed\\n" + "é".repeat(1000),
      facts: { reportPath: "artifacts/build-report.json" },
    }));
    console.log("Final child output");
    process.exitCode = 7;
  `,
  );
  const result = run(["package", "--tag", "lastcode/checkpoint/v0.1.0-nightly.20261122.1"], true);
  expect(result.status).toBe(7);
  const marker =
    "[lc-run] package: attention (exit 7) [build-failed]. Needs attention. Read the report below.\n";
  const tail = result.stdout.slice(result.stdout.lastIndexOf(marker));
  expect(result.stdout).toContain("Final child output\n" + marker);
  expect(tail).toMatch(
    /^\[lc-run\].*\nBuild failed é+\.\.\.\nReport: artifacts\/build-report\.json\n$/u,
  );
  expect(Buffer.byteLength(tail)).toBeLessThan(1_000);
});

it("does not start CI after preparation fails", () => {
  const { writeStep, run } = fixture();
  writeStep(
    "prepare-dependencies.ts",
    `
    console.log('[lastcode-action] Result: {"version":1,"outcome":"attention","summary":"Install failed"}');
    process.exitCode = process.argv[2] === "--for-ci" ? 43 : 99;
  `,
  );
  writeStep("lastcode-local-ci.ts", "console.log('Unexpected CI');");
  const result = run(["ci", "--quick"], true);
  expect(result.status).toBe(43);
  expect(result.stdout).toContain(
    "[lc-run] ci: attention (exit 43). Needs attention. Any available details are in this output.\nInstall failed\n",
  );
});

it("keeps a long report path in the full output and the failure in the wake tail", () => {
  const { writeStep, run } = fixture();
  const reportPath = "/checkout" + ("/" + "directory".repeat(20)).repeat(6) + "/report.json";
  writeStep("prepare-dependencies.ts", "");
  writeStep(
    "lastcode-local-ci.ts",
    `
    console.log("[lastcode-action] Result: " + JSON.stringify({
      version: 1, outcome: "attention", reason: "validation-failed",
      summary: "Full CI validation failed.", facts: { reportPath: ${JSON.stringify(reportPath)} },
    }));
    process.exitCode = 1;
  `,
  );
  const result = run(["ci", "--full"], false);
  expect(result.status).toBe(1);
  const tail =
    "[lc-run] ci: attention (exit 1) [validation-failed]. Needs attention. Read the report path in the full command output.\n" +
    "Full CI validation failed.\n";
  expect(result.stdout).toBe(`Report: ${reportPath}\n${tail}`);
  expect(Buffer.byteLength(tail)).toBeLessThan(1_000);
});

it("explains a blocked report even when the process exits successfully", () => {
  const { writeStep, run } = fixture();
  writeStep(
    "lastcode-wait-for-checkpoint.ts",
    `
    console.log('[lastcode-action] Result: {"version":1,"outcome":"blocked","summary":"Checkpoint unavailable","facts":{"diagnostic":"No active checkpoint."}}');
  `,
  );
  const result = run(["wait-checkpoint"], false);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    "[lc-run] wait-checkpoint: blocked (exit 0). Could not proceed. Any available details are in this output.\n" +
      "Checkpoint unavailable\nNo active checkpoint.\n",
  );
});
