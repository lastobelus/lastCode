// @effect-diagnostics nodeBuiltinImport:off -- Repository declaration coverage reads local source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

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

  it("keeps every repository-owned resumable Action on the shared reporting path", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
    const project = JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "t3.json"), "utf8")) as {
      readonly scripts: ReadonlyArray<ProjectScript>;
    };
    const actions = project.scripts.filter(({ id }) => id?.startsWith("lc-"));

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const scriptPath = /\bnode (scripts\/[^\s]+\.(?:ts|mjs))\b/u.exec(action.command)?.[1];
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
