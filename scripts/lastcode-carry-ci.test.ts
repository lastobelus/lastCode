// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise exact commit ranges in disposable repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { compileCarrySetSameBase } from "./lastcode-carry-replay.ts";
import { carrySquashBody, validateCarrySourceRange } from "./lastcode-carry-delivery.ts";
import { validateCarryPullRequest } from "./lastcode-carry-ci.ts";

function git(repo: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(repo: string, path: string, contents: string): void {
  const target = NodePath.join(repo, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "--message", subject, ...(body ? ["--message", body] : [])]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function manifest(repo: string, mode?: "carry"): void {
  write(
    repo,
    "scripts/lastcode-carry-set.json",
    `${JSON.stringify(mode ? { schemaVersion: 1, replay: { mode } } : { schemaVersion: 1 })}\n`,
  );
}

function fixture(): { readonly cleanup: () => void; readonly repo: string } {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-ci-"));
  git(repo, ["init", "--quiet", "--initial-branch=lastcode/main"]);
  git(repo, ["config", "user.name", "Carry CI test"]);
  git(repo, ["config", "user.email", "carry-ci@example.invalid"]);
  return { repo, cleanup: () => NodeFS.rmSync(repo, { recursive: true, force: true }) };
}

function compactFixture(repo: string) {
  manifest(repo, "carry");
  write(repo, "shared.txt", "upstream\n");
  const upstream = commit(repo, "upstream");
  write(repo, "shared.txt", "action behavior\n");
  const partition = commit(repo, "action modification", "Carry-Group: resumable-actions");
  const base = compileCarrySetSameBase({
    repo,
    worktree: repo,
    base: upstream,
    source: partition,
    preparedPartition: { base: upstream, source: partition, head: partition },
  }).head;
  return { upstream, base };
}

function snapshot(repo: string) {
  return {
    head: git(repo, ["rev-parse", "HEAD"]),
    index: git(repo, ["ls-files", "--stage"]),
    status: git(repo, ["status", "--porcelain", "--untracked-files=all"]),
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    worktrees: git(repo, ["worktree", "list", "--porcelain"]),
  };
}

describe("LastCode carry CI", () => {
  it("validates the bootstrap activation PR from the head policy", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const upstream = commit(repo, "base");
      write(repo, "tooling.txt", "tooling\n");
      const base = commit(repo, "prepared bootstrap", "Carry-Group: tooling");
      write(
        repo,
        "scripts/lastcode-carry-set.json",
        JSON.stringify({
          replay: { mode: "carry", bootstrap: { base: upstream, source: base, head: base } },
        }),
      );
      write(repo, "activation.txt", "activate\n");
      const head = commit(repo, "activate carry replay", "Carry-Group: tooling");

      expect(validateCarryPullRequest(repo, { base, head, number: 203 })).toEqual({
        active: true,
        source: {
          base,
          head,
          ref: `refs/lastcode/carry-sources/pr-203/${head}`,
        },
        compilation: {
          upstream,
          sourceTree: git(repo, ["rev-parse", `${head}^{tree}`]),
          compiledTree: git(repo, ["rev-parse", `${head}^{tree}`]),
        },
      });
    } finally {
      cleanup();
    }
  });

  it("rejects valid source assignments that conflict when regrouped, preserving the caller", () => {
    const { repo, cleanup } = fixture();
    try {
      const { base } = compactFixture(repo);
      git(repo, ["rm", "shared.txt"]);
      const head = commit(repo, "remove modified file", "Carry-Group: build-ci");
      expect(validateCarrySourceRange(repo, 208, base, head).head).toBe(head);
      write(repo, "untracked.txt", "keep this work\n");
      const before = snapshot(repo);
      expect(() => validateCarryPullRequest(repo, { base, head, number: 208 })).toThrow(
        /same-base carry compilation failed.*shared\.txt/su,
      );
      expect(snapshot(repo)).toEqual(before);
      expect(NodeFS.readFileSync(NodePath.join(repo, "untracked.txt"), "utf8")).toBe(
        "keep this work\n",
      );
    } finally {
      cleanup();
    }
  });

  it("reuses the compact chain and retained source contributions with an exact final tree", () => {
    const { repo, cleanup } = fixture();
    try {
      const { upstream, base: compact } = compactFixture(repo);
      write(repo, "prior.txt", "prior contribution\n");
      const prior = commit(repo, "prior contribution", "Carry-Group: tooling");
      const source = validateCarrySourceRange(repo, 209, compact, prior);
      git(repo, ["update-ref", source.ref, prior]);
      const tree = git(repo, ["rev-parse", `${prior}^{tree}`]);
      const base = git(repo, [
        "commit-tree",
        tree,
        "-p",
        compact,
        "-m",
        carrySquashBody("prior squash", source),
      ]);
      git(repo, ["checkout", "--detach", base]);
      write(repo, "pr.txt", "proposed contribution\n");
      const head = commit(repo, "proposed contribution", "Carry-Group: build-ci");
      const before = snapshot(repo);
      const result = validateCarryPullRequest(repo, { base, head, number: 210 });
      expect(result.compilation).toEqual({
        upstream,
        sourceTree: git(repo, ["rev-parse", `${head}^{tree}`]),
        compiledTree: git(repo, ["rev-parse", `${head}^{tree}`]),
      });
      expect(result.source?.head).toBe(head);
      expect(snapshot(repo)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("compiles a child PR together with its unsquashed parent contributions", () => {
    const { repo, cleanup } = fixture();
    try {
      const { upstream } = compactFixture(repo);
      write(repo, "parent.txt", "parent contribution\n");
      commit(repo, "first parent contribution", "Carry-Group: tooling");
      write(repo, "parent-action.txt", "parent action\n");
      const base = commit(repo, "second parent contribution", "Carry-Group: resumable-actions");
      write(repo, "child.txt", "child contribution\n");
      const head = commit(repo, "child contribution", "Carry-Group: build-ci");
      const before = snapshot(repo);
      expect(validateCarryPullRequest(repo, { base, head, number: 212 }).compilation).toEqual({
        upstream,
        sourceTree: git(repo, ["rev-parse", `${head}^{tree}`]),
        compiledTree: git(repo, ["rev-parse", `${head}^{tree}`]),
      });
      expect(snapshot(repo)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("rejects a clean bootstrap compilation whose tree differs from the proposed source", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const upstream = commit(repo, "upstream");
      write(repo, "tooling.txt", "tooling\n");
      const partition = commit(repo, "prepared contribution", "Carry-Group: tooling");
      git(repo, ["checkout", "--detach", upstream]);
      write(repo, "new-upstream.txt", "unrepresented change\n");
      const base = commit(repo, "represented source with another tree");
      write(
        repo,
        "scripts/lastcode-carry-set.json",
        JSON.stringify({
          replay: {
            mode: "carry",
            bootstrap: {
              base: upstream,
              source: partition,
              head: partition,
              representedSource: base,
              sourceTag: "lastcode/checkpoint/v0.1.0-nightly.20261022.1",
            },
          },
        }),
      );
      const head = commit(repo, "activate mismatched partition", "Carry-Group: tooling");
      const before = snapshot(repo);
      expect(() => validateCarryPullRequest(repo, { base, head, number: 211 })).toThrow(
        /Compiled carry tree .* does not equal PR source tree/u,
      );
      expect(snapshot(repo)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("keeps the base carry policy active when a PR removes it", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo, "carry");
      write(repo, "base.txt", "base\n");
      const base = commit(repo, "active base");
      manifest(repo);
      const head = commit(repo, "remove carry mode");

      expect(() => validateCarryPullRequest(repo, { base, head, number: 204 })).toThrow(
        /Commit .* must have exactly one Carry-Group trailer/u,
      );
    } finally {
      cleanup();
    }
  });

  it("checks every commit in an active PR and gives assignment guidance", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo, "carry");
      write(repo, "base.txt", "base\n");
      const base = commit(repo, "active base");
      write(repo, "assigned.txt", "assigned\n");
      commit(repo, "assigned change", "Carry-Group: build-ci");
      write(repo, "unassigned.txt", "unassigned\n");
      const head = commit(repo, "unassigned change");

      expect(() => validateCarryPullRequest(repo, { base, head, number: 205 })).toThrow(
        /Add exactly one Carry-Group trailer to every commit using one of: upstream-bugfixes, tooling, build-ci, resumable-actions, legacy-sidebar, incubator/u,
      );
    } finally {
      cleanup();
    }
  });

  it("does not require group metadata before either side activates carry replay", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const base = commit(repo, "base");
      write(repo, "ordinary.txt", "ordinary\n");
      const head = commit(repo, "ordinary unassigned change");

      expect(validateCarryPullRequest(repo, { base, head, number: 206 })).toEqual({
        active: false,
      });
    } finally {
      cleanup();
    }
  });

  it("requires exact available event commits", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo, "carry");
      write(repo, "base.txt", "base\n");
      const base = commit(repo, "base");
      expect(() =>
        validateCarryPullRequest(repo, { base: "HEAD", head: base, number: 207 }),
      ).toThrow("exact 40-character pull-request base commit");
      expect(() =>
        validateCarryPullRequest(repo, { base, head: "f".repeat(40), number: 207 }),
      ).toThrow("Fetch the complete base-to-head history");
    } finally {
      cleanup();
    }
  });
});
