// @effect-diagnostics nodeBuiltinImport:off - drives a scratch git repository.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { markOriginAsGhDefault } from "./lastcode-gh-default.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

describe("markOriginAsGhDefault", () => {
  it("moves gh's default from upstream to origin, and leaves a checkout without origin alone", () => {
    const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gh-default-"));
    try {
      git(repo, "init", "-q");
      git(repo, "remote", "add", "upstream", "git@github.com:parent/repo.git");
      git(repo, "config", "remote.upstream.gh-resolved", "base");

      markOriginAsGhDefault(repo);
      expect(git(repo, "config", "--get-regexp", "gh-resolved")).toBe(
        "remote.upstream.gh-resolved base",
      );

      git(repo, "remote", "add", "origin", "git@github.com:fork/repo.git");
      markOriginAsGhDefault(repo);
      expect(git(repo, "config", "--get-regexp", "gh-resolved")).toBe(
        "remote.origin.gh-resolved base",
      );
    } finally {
      NodeFS.rmSync(repo, { recursive: true, force: true });
    }
  });
});
