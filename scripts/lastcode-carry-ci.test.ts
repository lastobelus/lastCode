// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise exact commit ranges in disposable repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

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

describe("LastCode carry CI", () => {
  it("validates the bootstrap activation PR from the head policy", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const base = commit(repo, "base");
      manifest(repo, "carry");
      write(repo, "activation.txt", "activate\n");
      const head = commit(repo, "activate carry replay", "Carry-Group: tooling");

      expect(validateCarryPullRequest(repo, { base, head, number: 203 })).toEqual({
        active: true,
        source: {
          base,
          head,
          ref: `refs/lastcode/carry-sources/pr-203/${head}`,
        },
      });
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
