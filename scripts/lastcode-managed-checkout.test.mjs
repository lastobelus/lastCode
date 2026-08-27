import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedCheckoutBackupRef,
  normalizeManagedCheckoutConfig,
  parseManagedCheckoutArgs,
  syncManagedCheckout,
} from "./lastcode-managed-checkout.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(path, contents) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
}

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-checkout-"));
  temporaryDirectories.push(root);
  const remote = NodePath.join(root, "remote.git");
  const publisher = NodePath.join(root, "publisher");
  const managed = NodePath.join(root, "managed");
  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, publisher]);
  git(publisher, ["config", "user.email", "test@example.com"]);
  git(publisher, ["config", "user.name", "Test"]);
  write(NodePath.join(publisher, "tracked.txt"), "one\n");
  git(publisher, ["add", "tracked.txt"]);
  git(publisher, ["commit", "-m", "initial"]);
  git(publisher, ["branch", "-M", "release"]);
  git(publisher, ["push", "-u", "origin", "release"]);
  git(root, ["clone", "--branch", "release", remote, managed]);
  const gitCommonDirectory = NodeFS.realpathSync(NodePath.join(managed, ".git"));
  return {
    config: {
      backupRefPrefix: "refs/example/managed-checkout-backups",
      branch: "release",
      gitCommonDirectory,
      remote: "origin",
      remoteBranch: "release",
      worktree: managed,
    },
    managed,
    publisher,
  };
}

function publish(test, path, contents) {
  write(NodePath.join(test.publisher, path), contents);
  git(test.publisher, ["add", path]);
  git(test.publisher, ["commit", "-m", `update ${path}`]);
  git(test.publisher, ["push", "origin", "release"]);
  return git(test.publisher, ["rev-parse", "HEAD"]);
}

describe("managed checkout configuration", () => {
  it("accepts a complete environment-neutral configuration", () => {
    const test = fixture();
    expect(normalizeManagedCheckoutConfig(test.config)).toEqual(test.config);
  });

  it("requires explicit absolute checkout identity", () => {
    const test = fixture();
    expect(() => normalizeManagedCheckoutConfig({ ...test.config, worktree: "relative" })).toThrow(
      /absolute path/u,
    );
    expect(() =>
      normalizeManagedCheckoutConfig({ ...test.config, gitCommonDirectory: "/missing" }),
    ).not.toThrow();
  });

  it("parses only an explicit absolute config path", () => {
    expect(parseManagedCheckoutArgs(["sync", "--config", "/tmp/checkout.json"])).toEqual({
      command: "sync",
      configPath: "/tmp/checkout.json",
    });
    expect(() => parseManagedCheckoutArgs(["sync", "--config", "checkout.json"])).toThrow(
      /absolute JSON path/u,
    );
  });

  it("builds backup refs for SHA-1 and SHA-256 object IDs", () => {
    const prefix = "refs/example/managed-checkout-backups";
    expect(managedCheckoutBackupRef(prefix, "a".repeat(40))).toBe(`${prefix}/${"a".repeat(40)}`);
    expect(managedCheckoutBackupRef(prefix, "b".repeat(64), "sha256")).toBe(
      `${prefix}/${"b".repeat(64)}`,
    );
    expect(() => managedCheckoutBackupRef(prefix, "c".repeat(41))).toThrow(/invalid commit/u);
    expect(() => managedCheckoutBackupRef(prefix, "d".repeat(40), "unknown")).toThrow(
      /unsupported object format/u,
    );
  });
});

describe("syncManagedCheckout", () => {
  it("updates a clean reserved checkout and retains its old tip", () => {
    const test = fixture();
    const oldCommit = git(test.managed, ["rev-parse", "HEAD"]);
    const targetCommit = publish(test, "tracked.txt", "two\n");

    expect(syncManagedCheckout(test.config)).toEqual({
      backupRef: managedCheckoutBackupRef(test.config.backupRefPrefix, oldCommit),
      fromCommit: oldCommit,
      status: "updated",
      toCommit: targetCommit,
    });
    expect(git(test.managed, ["rev-parse", "HEAD"])).toBe(targetCommit);
    expect(NodeFS.readFileSync(NodePath.join(test.managed, "tracked.txt"), "utf8")).toBe("two\n");
    expect(
      git(test.managed, [
        "rev-parse",
        managedCheckoutBackupRef(test.config.backupRefPrefix, oldCommit),
      ]),
    ).toBe(oldCommit);
  });

  it("is idempotent when the remote branch is already current", () => {
    const test = fixture();
    const commit = git(test.managed, ["rev-parse", "HEAD"]);
    expect(syncManagedCheckout(test.config)).toEqual({ commit, status: "current" });
  });

  it("fetches only the configured branch without tags or submodules", () => {
    const test = fixture();
    publish(test, "tracked.txt", "two\n");
    const calls = [];
    const runGit = (cwd, args, options = {}) => {
      calls.push(args);
      const output = NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        input: options.input,
        maxBuffer: options.maxBuffer,
      });
      return options.raw ? output : output.trim();
    };

    syncManagedCheckout(test.config, { runGit });

    expect(calls).toContainEqual([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      "+refs/heads/release:refs/remotes/origin/release",
    ]);
  });

  it("refuses dirty, wrong-branch, and wrong-repository checkouts", () => {
    const dirty = fixture();
    write(NodePath.join(dirty.managed, "local.txt"), "local\n");
    expect(() => syncManagedCheckout(dirty.config)).toThrow(/uncommitted or untracked/u);

    const detached = fixture();
    git(detached.managed, ["checkout", "--detach"]);
    expect(() => syncManagedCheckout(detached.config)).toThrow(/must be on release/u);

    const wrongIdentity = fixture();
    const other = fixture();
    expect(() =>
      syncManagedCheckout({
        ...wrongIdentity.config,
        gitCommonDirectory: other.config.gitCommonDirectory,
      }),
    ).toThrow(/configured repository/u);
  });

  it("refuses a target that would replace ignored local content", () => {
    const test = fixture();
    write(NodePath.join(test.managed, ".git", "info", "exclude"), "generated/\n");
    write(NodePath.join(test.managed, "generated", "local.txt"), "local\n");
    publish(test, "generated/from-remote.txt", "remote\n");
    expect(() => syncManagedCheckout(test.config)).toThrow(/replace ignored content/u);
    expect(NodeFS.readFileSync(NodePath.join(test.managed, "generated", "local.txt"), "utf8")).toBe(
      "local\n",
    );
  });

  it("revalidates the checkout after fetching", () => {
    const test = fixture();
    publish(test, "tracked.txt", "two\n");
    expect(() =>
      syncManagedCheckout(test.config, {
        fetch: () => write(NodePath.join(test.managed, "late.txt"), "late\n"),
      }),
    ).toThrow(/uncommitted or untracked/u);
  });
});
