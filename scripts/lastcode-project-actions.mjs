#!/usr/bin/env node

// Reconcile repository-owned Project Actions into one explicitly managed LastCode environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { acquirePortableLock } from "./lastcode-lock.mjs";

const CANONICAL_UPSTREAM_URL =
  /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)(?:pingdotgg\/t3code)(?:\.git)?\/?$/u;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(result.stderr.trim() || result.stdout.trim() || `${command} failed.`);
  }
  return result.stdout.trim();
}

export function parseProjectActionArgs(argv) {
  if (argv[0] !== "reconcile") {
    fail(
      "Usage: lastcode-project-actions reconcile --repo-root <absolute-path> --base-dir <absolute-path> [--trusted-source-id <id>]...",
    );
  }
  let repoRoot;
  let baseDir;
  const trustedSourceIds = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--repo-root") repoRoot = value;
    else if (argument === "--base-dir") baseDir = value;
    else if (argument === "--trusted-source-id") trustedSourceIds.push(value);
    else fail(`Unknown argument '${argument}'.`);
    if (value === undefined) fail(`${argument} requires a value.`);
    index += 1;
  }
  if (!NodePath.isAbsolute(repoRoot ?? "")) fail("--repo-root must be an absolute path.");
  if (!NodePath.isAbsolute(baseDir ?? "")) fail("--base-dir must be an absolute path.");
  if (
    trustedSourceIds.some((value) => typeof value !== "string" || !/^lc-[a-z0-9-]+$/u.test(value))
  ) {
    fail("--trusted-source-id values must be stable lc-* Action ids.");
  }
  return {
    command: "reconcile",
    repoRoot: NodePath.resolve(repoRoot),
    baseDir: NodePath.resolve(baseDir),
    trustedSourceIds: [...new Set(trustedSourceIds)].toSorted(),
  };
}

export function assertManagedLastCodeAnchor(repoRoot, execute = run) {
  const realRoot = NodeFS.realpathSync(repoRoot);
  const topLevel = NodeFS.realpathSync(
    execute("git", ["rev-parse", "--show-toplevel"], { cwd: realRoot }),
  );
  if (topLevel !== realRoot) fail("Managed LastCode anchor resolved to an unexpected worktree.");
  const branch = execute("git", ["branch", "--show-current"], { cwd: realRoot });
  if (branch !== "lastcode/main") {
    fail(`Managed LastCode anchor must be on lastcode/main; found '${branch || "detached HEAD"}'.`);
  }
  const upstream = execute("git", ["remote", "get-url", "upstream"], { cwd: realRoot });
  if (!CANONICAL_UPSTREAM_URL.test(upstream)) {
    fail("Managed LastCode anchor does not have the canonical T3 Code upstream remote.");
  }
  const sourceFile = NodePath.join(realRoot, "t3.json");
  if (!NodeFS.existsSync(sourceFile)) fail("Managed LastCode anchor does not contain t3.json.");
  return { realRoot, sourceFile };
}

export function managedProjectActionStateFile(baseDir, workspaceRoot) {
  const workspaceKey = NodeCrypto.createHash("sha256").update(workspaceRoot).digest("hex");
  return NodePath.join(
    baseDir,
    "userdata",
    "lastcode",
    "managed-project-actions",
    `${workspaceKey}.json`,
  );
}

export function reconcileLastCodeProjectActions(options, dependencies = {}) {
  const execute = dependencies.execute ?? run;
  const { realRoot, sourceFile } = assertManagedLastCodeAnchor(options.repoRoot, execute);
  const stateFile = managedProjectActionStateFile(options.baseDir, realRoot);
  const acquireLock =
    dependencies.acquireLock ??
    ((filePath) =>
      acquirePortableLock(
        NodePath.dirname(filePath),
        `${NodePath.basename(filePath)}.lock`,
        "Project Action reconciliation",
      ));
  const args = [
    NodePath.join(realRoot, "apps", "server", "src", "bin.ts"),
    "project",
    "reconcile-actions",
    realRoot,
    "--source-file",
    sourceFile,
    "--state-file",
    stateFile,
    "--create-if-missing",
    "--base-dir",
    options.baseDir,
  ];
  if (options.trustedSourceIds.length > 0) {
    args.push("--trusted-source-ids", options.trustedSourceIds.join(","));
  }
  const releaseLock = acquireLock(stateFile);
  try {
    const output = execute(process.execPath, args, { cwd: realRoot });
    return JSON.parse(output);
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  try {
    const options = parseProjectActionArgs(process.argv.slice(2));
    console.log(JSON.stringify(reconcileLastCodeProjectActions(options)));
  } catch (error) {
    console.error(
      `[lastcode:project-actions] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
