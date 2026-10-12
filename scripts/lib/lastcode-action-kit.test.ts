// @effect-diagnostics nodeBuiltinImport:off -- Repository declaration coverage reads local source files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  ACTION_EVENT_TOKEN_ENV,
  ACTION_RUN_ID_ENV,
  createActionProtocolDecoder,
} from "@t3tools/shared/actionResumeProtocol";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createLastCodeActionReporter } from "./lastcode-action-kit.ts";

type ProjectScript = {
  readonly id?: string;
  readonly name: string;
  readonly command: string;
};

describe("LastCode Action kit", () => {
  it("allows one terminal result and rejects a second", () => {
    const output: string[] = [];
    const action = createLastCodeActionReporter({
      env: {},
      write: () => undefined,
      log: (message) => output.push(message),
    });

    action.progress({ state: "working", summary: "Running checks" });
    action.result({ outcome: "success", summary: "Checks passed" });

    expect(output).toHaveLength(2);
    expect(output[1]).toContain('"summary":"Checks passed"');
    expect(() =>
      action.result({ outcome: "attention", summary: "Unexpected second result" }),
    ).toThrow("only one terminal result");
    expect(output).toHaveLength(2);
  });

  it("emits frames the host Action protocol decoder accepts", () => {
    const runId = "kit-run";
    const token = "kit-token";
    let output = "";
    const action = createLastCodeActionReporter({
      env: { [ACTION_RUN_ID_ENV]: runId, [ACTION_EVENT_TOKEN_ENV]: token },
      write: (data) => {
        output += data;
      },
    });

    action.progress({ state: "waiting", phase: "checkpoint", summary: "Waiting for the run" });
    action.result({ outcome: "success", reason: "completed", summary: "Checkpoint finished" });

    const decoder = createActionProtocolDecoder({ runId, token });
    const decoded = decoder.push(output);
    expect(decoded.invalidFrames).toBe(0);
    expect(decoded.output + decoder.finish()).toBe("");
    expect(decoded.events).toEqual([
      {
        kind: "progress",
        progress: {
          version: 1,
          state: "waiting",
          phase: "checkpoint",
          summary: "Waiting for the run",
        },
      },
      {
        kind: "result",
        report: {
          version: 1,
          outcome: "success",
          reason: "completed",
          summary: "Checkpoint finished",
        },
      },
    ]);
  });

  it("loads the checkpoint waiter from a checkout whose dependencies are missing", () => {
    // The waiter starts while the checkpoint service reinstalls the primary checkout's dependencies.
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-action-kit-"));
    onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const scripts = NodePath.resolve(import.meta.dirname, "..");
    NodeFS.mkdirSync(NodePath.join(root, "scripts", "lib"), { recursive: true });
    for (const file of ["lastcode-wait-for-checkpoint.ts", "lib/lastcode-action-kit.ts"]) {
      NodeFS.copyFileSync(NodePath.join(scripts, file), NodePath.join(root, "scripts", file));
    }

    const waiter = NodePath.join(root, "scripts", "lastcode-wait-for-checkpoint.ts");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "await import(process.argv[1])",
        NodeURL.pathToFileURL(waiter).href,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("keeps every repository-owned resumable Action on the shared reporting path", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
    const project = JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "t3.json"), "utf8")) as {
      readonly scripts: ReadonlyArray<ProjectScript>;
    };
    const actions = project.scripts.filter(({ id }) => id?.startsWith("lc-"));

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const scriptPath =
        /\bnode (?:"\$T3CODE_PROJECT_ROOT\/)?(scripts\/[^\s"]+\.(?:ts|mjs))\b/u.exec(
          action.command,
        )?.[1];
      expect(scriptPath, `${action.name} must run a repository-owned script`).toBeDefined();

      const source = NodeFS.readFileSync(NodePath.join(repoRoot, scriptPath!), "utf8");
      expect(source, `${action.name} must import the LastCode Action kit`).toContain(
        'from "./lib/lastcode-action-kit.ts"',
      );
      expect(source, `${action.name} must report coarse progress`).toContain(
        "lastCodeAction.progress",
      );
      expect(source, `${action.name} must report a compact terminal result`).toContain(
        "lastCodeAction.result",
      );
    }
  });
});
