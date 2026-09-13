import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  assertManagedLastCodeAnchor,
  managedProjectActionStateFile,
  parseProjectActionArgs,
  reconcileLastCodeProjectActions,
} from "./lastcode-project-actions.mjs";

describe("lastcode project action arguments", () => {
  it("parses one environment and an explicit trust allowlist", () => {
    expect(
      parseProjectActionArgs([
        "reconcile",
        "--repo-root",
        "/srv/example/lastCode",
        "--base-dir",
        "/srv/example/t3-home",
        "--trusted-source-id",
        "lc-wait-for-pr",
        "--trusted-source-id",
        "lc-wait-for-pr",
      ]),
    ).toEqual({
      command: "reconcile",
      repoRoot: "/srv/example/lastCode",
      baseDir: "/srv/example/t3-home",
      trustedSourceIds: ["lc-wait-for-pr"],
    });
  });

  it("requires absolute paths and stable trust ids", () => {
    expect(() =>
      parseProjectActionArgs([
        "reconcile",
        "--repo-root",
        "relative",
        "--base-dir",
        "/srv/example/t3-home",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseProjectActionArgs([
        "reconcile",
        "--repo-root",
        "/srv/example/lastCode",
        "--base-dir",
        "/srv/example/t3-home",
        "--trusted-source-id",
        "wait-for-pr",
      ]),
    ).toThrow("stable lc-*");
  });
});

describe("managed LastCode anchor", () => {
  it("keys ownership state by normalized workspace", () => {
    const baseDir = "/srv/example/t3-home";
    const first = managedProjectActionStateFile(baseDir, "/srv/example/lastCode");
    const second = managedProjectActionStateFile(baseDir, "/srv/example/other-lastCode");
    expect(first).not.toBe(second);
    expect(first).toMatch(/managed-project-actions\/[0-9a-f]{64}\.json$/u);
  });

  it("requires the canonical branch, repository root, upstream, and t3.json", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-actions-anchor-"));
    NodeFS.writeFileSync(NodePath.join(repoRoot, "t3.json"), "{}\n");
    const execute = (_command, args) => {
      if (args[0] === "rev-parse") return repoRoot;
      if (args[0] === "branch") return "lastcode/main";
      if (args[0] === "remote") return "https://github.com/pingdotgg/t3code.git";
      throw new Error(`Unexpected args: ${args.join(" ")}`);
    };
    const realRoot = NodeFS.realpathSync(repoRoot);

    expect(assertManagedLastCodeAnchor(repoRoot, execute)).toEqual({
      realRoot,
      sourceFile: NodePath.join(realRoot, "t3.json"),
    });
    expect(() =>
      assertManagedLastCodeAnchor(repoRoot, (_command, args) =>
        args[0] === "branch" ? "feature/work" : execute(_command, args),
      ),
    ).toThrow("must be on lastcode/main");
  });

  it("invokes the event-sourced project CLI with environment-local state", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-actions-run-"));
    const baseDir = NodePath.join(repoRoot, "environment");
    NodeFS.writeFileSync(NodePath.join(repoRoot, "t3.json"), "{}\n");
    const calls = [];
    const releaseLock = vi.fn();
    const acquireLock = vi.fn(() => releaseLock);
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "git" && args[0] === "rev-parse") return repoRoot;
      if (command === "git" && args[0] === "branch") return "lastcode/main";
      if (command === "git" && args[0] === "remote") return "git@github.com:pingdotgg/t3code.git";
      return JSON.stringify({ mode: "offline", created: ["lc-wait-for-pr"] });
    };

    expect(
      reconcileLastCodeProjectActions(
        {
          repoRoot,
          baseDir,
          trustedSourceIds: ["lc-wait-for-pr"],
        },
        { acquireLock, execute },
      ),
    ).toEqual({ mode: "offline", created: ["lc-wait-for-pr"] });
    const invocation = calls.at(-1);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toContain("reconcile-actions");
    expect(invocation.args).toContain(
      managedProjectActionStateFile(baseDir, NodeFS.realpathSync(repoRoot)),
    );
    expect(invocation.args).toContain("lc-wait-for-pr");
    expect(acquireLock).toHaveBeenCalledWith(
      managedProjectActionStateFile(baseDir, NodeFS.realpathSync(repoRoot)),
    );
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("releases workspace ownership after reconciliation fails", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-actions-lock-"));
    const baseDir = NodePath.join(repoRoot, "environment");
    NodeFS.writeFileSync(NodePath.join(repoRoot, "t3.json"), "{}\n");
    const releaseLock = vi.fn();
    const execute = (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return repoRoot;
      if (command === "git" && args[0] === "branch") return "lastcode/main";
      if (command === "git" && args[0] === "remote") {
        return "https://github.com/pingdotgg/t3code.git";
      }
      throw new Error("reconciliation failed");
    };

    expect(() =>
      reconcileLastCodeProjectActions(
        { repoRoot, baseDir, trustedSourceIds: [] },
        { acquireLock: () => releaseLock, execute },
      ),
    ).toThrow("reconciliation failed");
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
