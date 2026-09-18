// @effect-diagnostics nodeBuiltinImport:off -- These tests use disposable Git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  assertNoReservedCarrySourceTrailers,
  carrySourceRef,
  carrySquashBody,
  preserveCarrySource,
  shouldRetainCarrySources,
  validateCarrySourceRange,
} from "./lastcode-carry-delivery.ts";
import { assertMergeBaseUnchanged } from "./lastcode-merge.ts";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo: string, file: string, message: string): string {
  NodeFS.writeFileSync(NodePath.join(repo, file), `${message}\n`);
  git(repo, ["add", file]);
  git(repo, ["commit", "--quiet", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("LastCode carry delivery", () => {
  it("activates only for the explicit carry replay mode", () => {
    expect(shouldRetainCarrySources({})).toBe(false);
    expect(shouldRetainCarrySources({ replay: { mode: "historical" } })).toBe(false);
    expect(shouldRetainCarrySources({ replay: { mode: "carry" } })).toBe(true);
  });

  it("retains a linear assigned source range at its immutable PR ref", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-delivery-"));
    const bare = NodePath.join(root, "remote.git");
    const repo = NodePath.join(root, "reviewed");
    try {
      git(root, ["init", "--bare", "--quiet", bare]);
      git(root, ["clone", "--quiet", bare, repo]);
      git(repo, ["config", "user.name", "Carry delivery test"]);
      git(repo, ["config", "user.email", "carry-delivery@example.invalid"]);
      const base = commit(repo, "base.txt", "base");
      git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/lastcode/main`]);
      git(repo, ["fetch", "--quiet", "origin", "lastcode/main"]);
      expect(() => assertMergeBaseUnchanged(repo, base)).not.toThrow();
      commit(repo, "tooling.txt", "tooling\n\nCarry-Group: tooling");
      const head = commit(repo, "actions.txt", "actions\n\nCarry-Group: resumable-actions");

      const source = validateCarrySourceRange(repo, 42, base, head);
      preserveCarrySource(repo, source);
      preserveCarrySource(repo, source);

      expect(source).toEqual({ base, head, ref: carrySourceRef(42, head) });
      expect(git(repo, ["rev-parse", source.ref])).toBe(head);
      expect(git(bare, ["rev-parse", source.ref])).toBe(head);
      const differentHead = commit(repo, "later.txt", "later\n\nCarry-Group: tooling");
      git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/lastcode/main`]);
      git(bare, ["update-ref", source.ref, differentHead]);
      expect(() => preserveCarrySource(repo, source)).toThrow("Remote carry source ref");
      git(repo, ["push", "--quiet", "origin", `HEAD:refs/heads/lastcode/main`]);
      git(repo, ["fetch", "--quiet", "origin", "lastcode/main"]);
      expect(() => assertMergeBaseUnchanged(repo, base, "after source push")).toThrow(
        "after source push",
      );
      expect(carrySquashBody("Problem fixed\n\nCodex / T3 Code", source)).toBe(
        `Problem fixed\n\nCodex / T3 Code\n\nCarry-Source-Ref: ${source.ref}\nCarry-Source-Base: ${base}\nCarry-Source-Head: ${head}\n`,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects caller-provided carry source trailers before composing the squash body", () => {
    expect(() => assertNoReservedCarrySourceTrailers("Carry-Source-Ref: refs/attacker")).toThrow(
      "must not set Carry-Source-Ref",
    );
    expect(() =>
      carrySquashBody("Carry-Source-Base: attacker", {
        base: "a".repeat(40),
        head: "b".repeat(40),
        ref: "refs/lastcode/carry-sources/pr-1/b",
      }),
    ).toThrow("must not set Carry-Source-Ref");
    expect(() => assertNoReservedCarrySourceTrailers("Carry-Source-Head:\n")).toThrow(
      "must not set Carry-Source-Ref",
    );
  });

  it("refuses an unassigned source commit", () => {
    const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-delivery-"));
    try {
      git(repo, ["init", "--quiet"]);
      git(repo, ["config", "user.name", "Carry delivery test"]);
      git(repo, ["config", "user.email", "carry-delivery@example.invalid"]);
      const base = commit(repo, "base.txt", "base");
      const head = commit(repo, "missing.txt", "missing trailer");
      expect(() => validateCarrySourceRange(repo, 1, base, head)).toThrow("Carry-Group trailer");
    } finally {
      NodeFS.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a reviewed range containing a merge commit", () => {
    const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-delivery-"));
    try {
      git(repo, ["init", "--quiet"]);
      git(repo, ["config", "user.name", "Carry delivery test"]);
      git(repo, ["config", "user.email", "carry-delivery@example.invalid"]);
      const base = commit(repo, "base.txt", "base");
      git(repo, ["switch", "--quiet", "-c", "side"]);
      commit(repo, "side.txt", "side\n\nCarry-Group: tooling");
      git(repo, ["switch", "--quiet", "-"]);
      commit(repo, "main.txt", "main\n\nCarry-Group: incubator");
      git(repo, ["merge", "--no-ff", "--no-edit", "side"]);
      const head = git(repo, ["rev-parse", "HEAD"]);

      expect(() => validateCarrySourceRange(repo, 1, base, head)).toThrow("not single-parent");
    } finally {
      NodeFS.rmSync(repo, { recursive: true, force: true });
    }
  });
});
