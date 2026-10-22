// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise exact commit ranges in disposable repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

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

function activateCarry(repo: string, base: string, source: string): string {
  write(
    repo,
    "scripts/lastcode-carry-set.json",
    JSON.stringify({ replay: { mode: "carry", bootstrap: { base, source, head: source } } }),
  );
  return commit(repo, "activate carry replay", "Carry-Group: tooling");
}

function fixture(): { readonly cleanup: () => void; readonly repo: string } {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-ci-"));
  git(repo, ["init", "--quiet", "--initial-branch=lastcode/main"]);
  git(repo, ["config", "user.name", "Carry CI test"]);
  git(repo, ["config", "user.email", "carry-ci@example.invalid"]);
  return { repo, cleanup: () => NodeFS.rmSync(repo, { recursive: true, force: true }) };
}

function compactFixture(repo: string) {
  manifest(repo);
  write(repo, "shared.txt", "upstream\n");
  const upstream = commit(repo, "upstream");
  write(repo, "shared.txt", "action behavior\n");
  const partition = commit(repo, "action modification", "Carry-Group: resumable-actions");
  const source = activateCarry(repo, upstream, partition);
  const base = compileCarrySetSameBase({
    repo,
    worktree: repo,
    base: upstream,
    source,
    preparedPartition: { base: upstream, source, head: source },
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
  it.each([{ mode: "carry" }, { mode: "invalid" }])(
    "rejects invalid proposed replay configuration $mode even with a compact chain",
    (replay) => {
      const { repo, cleanup } = fixture();
      try {
        const { base } = compactFixture(repo);
        write(repo, "scripts/lastcode-carry-set.json", JSON.stringify({ replay }));
        const head = commit(repo, "change replay configuration", "Carry-Group: build-ci");
        const before = snapshot(repo);
        expect(() => validateCarryPullRequest(repo, { base, head, number: 217 })).toThrow(
          /Carry replay (mode requires replay.bootstrap|manifest mode must be 'carry')/u,
        );
        expect(snapshot(repo)).toEqual(before);
      } finally {
        cleanup();
      }
    },
  );

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

  it("fetches a remote-only prepared bootstrap without changing caller state", () => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const upstream = commit(repo, "upstream");
      write(repo, "tooling.txt", "tooling\n");
      const base = commit(repo, "historical source");
      const prepared = git(repo, [
        "commit-tree",
        `${base}^{tree}`,
        "-p",
        upstream,
        "-m",
        "prepared contribution",
        "-m",
        "Carry-Group: tooling",
      ]);
      const ref = "refs/lastcode/bootstrap/prepared";
      write(
        repo,
        "scripts/lastcode-carry-set.json",
        JSON.stringify({
          replay: {
            mode: "carry",
            bootstrap: { base: upstream, source: base, head: prepared, ref },
          },
        }),
      );
      const head = commit(repo, "activate carry replay", "Carry-Group: tooling");
      const remote = NodePath.join(repo, "remote.git");
      git(repo, ["init", "--bare", "--quiet", remote]);
      git(repo, [
        "push",
        "--quiet",
        remote,
        `${head}:refs/heads/lastcode/main`,
        `${prepared}:${ref}`,
      ]);
      git(remote, ["update-ref", "refs/tags/prepared", prepared]);
      const caller = NodePath.join(repo, "caller");
      git(repo, [
        "clone",
        "--quiet",
        "--no-local",
        "--single-branch",
        "--branch=lastcode/main",
        remote,
        caller,
      ]);
      expect(
        NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${prepared}^{commit}`], {
          cwd: caller,
        }).status,
      ).not.toBe(0);
      git(caller, [
        "config",
        "--add",
        "remote.origin.fetch",
        `+${ref}:refs/remotes/origin/bootstrap`,
      ]);
      git(caller, ["config", "remote.origin.tagOpt", "--tags"]);
      git(caller, ["update-ref", "refs/remotes/origin/bootstrap", base]);
      write(caller, ".git/FETCH_HEAD", "preserve fetch state\n");
      write(caller, "base.txt", "staged work\n");
      git(caller, ["add", "base.txt"]);
      write(caller, "base.txt", "unstaged work\n");
      write(caller, "untracked.txt", "untracked work\n");
      const before = snapshot(caller);

      expect(validateCarryPullRequest(caller, { base, head, number: 213 }).compilation).toEqual({
        upstream,
        sourceTree: git(caller, ["rev-parse", `${head}^{tree}`]),
        compiledTree: git(caller, ["rev-parse", `${head}^{tree}`]),
      });
      expect(git(caller, ["rev-parse", "--verify", `${prepared}^{commit}`])).toBe(prepared);
      expect(snapshot(caller)).toEqual(before);
      expect(NodeFS.readFileSync(NodePath.join(caller, ".git/FETCH_HEAD"), "utf8")).toBe(
        "preserve fetch state\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(caller, "base.txt"), "utf8")).toBe(
        "unstaged work\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(caller, "untracked.txt"), "utf8")).toBe(
        "untracked work\n",
      );
    } finally {
      cleanup();
    }
  });

  it.each([
    ["refs/lastcode/bootstrap/prepared:refs/heads/other", /fully qualified Git ref/u],
    ["refs/lastcode/bootstrap/prepared", /on origin must equal pinned head/u],
  ])("rejects an invalid or moved bootstrap ref %s", (ref, message) => {
    const { repo, cleanup } = fixture();
    try {
      manifest(repo);
      write(repo, "base.txt", "base\n");
      const upstream = commit(repo, "upstream");
      write(repo, "tooling.txt", "tooling\n");
      const base = commit(repo, "prepared contribution", "Carry-Group: tooling");
      write(
        repo,
        "scripts/lastcode-carry-set.json",
        JSON.stringify({
          replay: { mode: "carry", bootstrap: { base: upstream, source: base, head: base, ref } },
        }),
      );
      const head = commit(repo, "activate carry replay", "Carry-Group: tooling");
      const remote = NodePath.join(repo, "remote.git");
      git(repo, ["init", "--bare", "--quiet", remote]);
      git(remote, ["fetch", "--quiet", repo, `${upstream}:refs/lastcode/bootstrap/prepared`]);
      git(repo, ["remote", "add", "origin", remote]);
      const before = snapshot(repo);
      expect(() => validateCarryPullRequest(repo, { base, head, number: 214 })).toThrow(message);
      expect(snapshot(repo)).toEqual(before);
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

  it("restores missing ordinary-index files in the isolated checkout, preserving caller work", () => {
    const { repo, cleanup } = fixture();
    const nativeSpawn = NodeChildProcess.spawnSync;
    const paths = [
      ".repos/alchemy-effect/.gitattributes",
      "apps/mobile/modules/t3-terminal/Vendor/libghostty/GhosttyKit.xcframework/ios-arm64/libghostty-fat.a",
    ];
    const runtimeChildProcess = (
      NodeChildProcess as typeof NodeChildProcess & {
        readonly default: typeof NodeChildProcess;
      }
    ).default;
    const spawn = vi.spyOn(runtimeChildProcess, "spawnSync");
    try {
      manifest(repo);
      for (const path of paths) write(repo, path, "tracked vendor fixture\n");
      const upstream = commit(repo, "upstream");
      write(repo, "tooling.txt", "tooling\n");
      const partition = commit(repo, "tooling contribution", "Carry-Group: tooling");
      const source = activateCarry(repo, upstream, partition);
      const compact = compileCarrySetSameBase({
        repo,
        worktree: repo,
        base: upstream,
        source,
        preparedPartition: { base: upstream, source, head: source },
      }).head;
      write(repo, "prior.txt", "retained contribution\n");
      const prior = commit(repo, "prior contribution", "Carry-Group: tooling");
      const retained = validateCarrySourceRange(repo, 215, compact, prior);
      git(repo, ["update-ref", retained.ref, prior]);
      const base = git(repo, [
        "commit-tree",
        `${prior}^{tree}`,
        "-p",
        compact,
        "-m",
        carrySquashBody("prior squash", retained),
      ]);
      git(repo, ["checkout", "--quiet", "--detach", base]);
      write(repo, "pr.txt", "proposed contribution\n");
      const head = commit(repo, "proposed contribution", "Carry-Group: build-ci");
      const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
      write(repo, "pr.txt", "staged work\n");
      git(repo, ["add", "pr.txt"]);
      write(repo, "pr.txt", "unstaged work\n");
      write(repo, "untracked.txt", "untracked work\n");
      const before = snapshot(repo);
      const index = NodeFS.readFileSync(NodePath.join(repo, ".git/index"));
      const config = NodeFS.readFileSync(NodePath.join(repo, ".git/config"));
      let seeded = 0;
      spawn.mockImplementation((command, args, options) => {
        const result = nativeSpawn(command, args, options);
        if (
          command === "git" &&
          args !== undefined &&
          args.includes("clone") &&
          args.includes("--no-checkout") &&
          args.at(-2) === repo &&
          result.status === 0
        ) {
          const isolated = args.at(-1)!;
          // Model the hosted failure: ordinary H entries with physically missing files.
          git(isolated, ["read-tree", "HEAD"]);
          git(isolated, ["checkout-index", "--all"]);
          for (const path of paths) NodeFS.unlinkSync(NodePath.join(isolated, path));
          expect(git(isolated, ["write-tree"])).toBe(tree);
          expect(git(isolated, ["ls-files", "-t", "--", ...paths])).toBe(
            paths.map((path) => `H ${path}`).join("\n"),
          );
          expect(git(isolated, ["diff", "--name-only"]).split("\n")).toEqual(paths);
          seeded++;
        }
        return result;
      });
      NodeModule.syncBuiltinESMExports();

      expect(validateCarryPullRequest(repo, { base, head, number: 216 }).compilation).toEqual({
        upstream,
        sourceTree: tree,
        compiledTree: tree,
      });
      expect(seeded).toBe(1);
      expect(snapshot(repo)).toEqual(before);
      expect(NodeFS.readFileSync(NodePath.join(repo, ".git/index"))).toEqual(index);
      expect(NodeFS.readFileSync(NodePath.join(repo, ".git/config"))).toEqual(config);
      expect(NodeFS.readFileSync(NodePath.join(repo, "pr.txt"), "utf8")).toBe("unstaged work\n");
      expect(NodeFS.readFileSync(NodePath.join(repo, "untracked.txt"), "utf8")).toBe(
        "untracked work\n",
      );
    } finally {
      spawn.mockRestore();
      NodeModule.syncBuiltinESMExports();
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
