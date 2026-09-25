// @effect-diagnostics nodeBuiltinImport:off -- Disposable Git fixtures exercise host-side locking.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { acquireMainWriteLock, MAIN_WRITE_LOCK_REF } from "./lastcode-main-write-lock.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-main-lock-"));
  directories.push(root);
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const remote = NodePath.join(root, "remote.git");
  const first = NodePath.join(root, "first");
  const second = NodePath.join(root, "second");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", first]);
  git(first, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "source",
  ]);
  const source = git(first, ["rev-parse", "HEAD"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);
  git(root, ["clone", "--branch", "lastcode/main", remote, second]);
  return {
    root,
    remote,
    first,
    second,
    source,
    git,
    owner: () => git(root, ["--git-dir", remote, "show-ref", "--hash", MAIN_WRITE_LOCK_REF]),
  };
}

describe("main write lock", () => {
  it("releases after a confirmed successful main push", () => {
    const f = fixture();
    const lock = acquireMainWriteLock(f.first, "origin", f.source, "checkpoint");
    lock.push([
      "push",
      "--no-verify",
      `--force-with-lease=refs/heads/lastcode/main:${f.source}`,
      "origin",
      `${f.source}:refs/heads/lastcode/main`,
    ]);
    lock.release();
    const next = acquireMainWriteLock(f.second, "origin", f.source, "merge");
    next.release();
  });

  it("retains ownership after an ambiguous PR merge failure", () => {
    const f = fixture();
    const bin = NodePath.join(f.root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`);
    const lock = acquireMainWriteLock(f.first, "origin", f.source, "merge");
    const owner = f.owner();
    expect(() => lock.merge(["pr", "merge", "1"])).toThrow("PR merge outcome is uncertain");
    expect(() => lock.release()).toThrow("Retained main write lock");
    expect(f.owner()).toBe(owner);
  });

  for (const state of ["OPEN", "MERGED"]) {
    it(`requires terminal merge confirmation before releasing (${state})`, () => {
      const f = fixture();
      const bin = NodePath.join(f.root, "bin");
      NodeFS.mkdirSync(bin);
      NodeFS.writeFileSync(
        NodePath.join(bin, "gh"),
        `#!/bin/sh\nif [ "$2" = view ]; then echo '{"state":"${state}","headRefOid":"${f.source}"}'; fi\nexit 0\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`);
      const lock = acquireMainWriteLock(f.first, "origin", f.source, "merge");
      const args = [
        "pr",
        "merge",
        "1",
        "--repo",
        "example/repository",
        "--match-head-commit",
        f.source,
      ];
      if (state === "MERGED") {
        lock.merge(args);
        lock.release();
        acquireMainWriteLock(f.second, "origin", f.source, "checkpoint").release();
      } else {
        const owner = f.owner();
        expect(() => lock.merge(args)).toThrow("has not completed");
        expect(() => lock.release()).toThrow("Retained main write lock");
        expect(f.owner()).toBe(owner);
      }
    });
  }

  it("excludes another checkout and allows it after release", () => {
    const f = fixture();
    const first = acquireMainWriteLock(f.first, "origin", f.source, "checkpoint");
    const owner = f.owner();
    expect(() => acquireMainWriteLock(f.second, "origin", f.source, "merge")).toThrow(
      "Could not acquire",
    );
    expect(f.owner()).toBe(owner);
    first.release();
    const second = acquireMainWriteLock(f.second, "origin", f.source, "merge");
    expect(f.owner()).not.toBe(owner);
    second.release();
  });

  it("cannot release a replacement owner's lock", () => {
    const f = fixture();
    const first = acquireMainWriteLock(f.first, "origin", f.source, "checkpoint");
    f.git(f.root, ["--git-dir", f.remote, "update-ref", MAIN_WRITE_LOCK_REF, f.source]);
    expect(() => first.release()).toThrow("Could not release");
    expect(f.owner()).toBe(f.source);
  });

  it("preserves a concurrent main update through the source lease and releases after rejection", () => {
    const f = fixture();
    const first = acquireMainWriteLock(f.first, "origin", f.source, "checkpoint");
    f.git(f.second, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "merged work",
    ]);
    const merged = f.git(f.second, ["rev-parse", "HEAD"]);
    f.git(f.second, ["push", "origin", "HEAD:refs/heads/lastcode/main"]);
    expect(() =>
      first.push([
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/lastcode/main:${f.source}`,
        "origin",
        `${f.source}:refs/heads/lastcode/main`,
      ]),
    ).toThrow("Checkpoint push failed");
    expect(f.git(f.root, ["--git-dir", f.remote, "rev-parse", "refs/heads/lastcode/main"])).toBe(
      merged,
    );
    first.release();
  });

  it("retains ownership when a push transport fails ambiguously", () => {
    const f = fixture();
    const first = acquireMainWriteLock(f.first, "origin", f.source, "checkpoint");
    const owner = f.owner();
    expect(() =>
      first.push([
        "push",
        "--no-verify",
        NodePath.join(f.root, "missing.git"),
        `${f.source}:refs/heads/lastcode/main`,
      ]),
    ).toThrow("Checkpoint push failed");
    expect(() => first.release()).toThrow("Retained main write lock");
    expect(f.owner()).toBe(owner);
    expect(() => acquireMainWriteLock(f.second, "origin", f.source, "merge")).toThrow(
      "Could not acquire",
    );
  });
});
