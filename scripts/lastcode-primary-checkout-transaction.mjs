#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const EXPECTED_ENV = "LASTCODE_CHECKOUT_EXPECTED";
const PROMOTED_ENV = "LASTCODE_CHECKOUT_PROMOTED";
const STATE_ENV = "LASTCODE_CHECKOUT_TRANSACTION_STATE";
const WORKTREE_ENV = "LASTCODE_CHECKOUT_WORKTREE";
const ZERO_OID = "0".repeat(40);

function fail(message) {
  throw new Error(message);
}

function runGit(worktree, args, environment = process.env) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    env: environment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

export function guardReferenceTransaction(phase, input, environment = process.env) {
  const expectedCommit = environment[EXPECTED_ENV];
  const promotedCommit = environment[PROMOTED_ENV];
  const statePath = environment[STATE_ENV];
  const worktree = environment[WORKTREE_ENV];
  if (!expectedCommit || !promotedCommit || !statePath || !worktree) {
    fail("Primary checkout transaction guard is missing its expected state.");
  }
  const updates = input.split(/\r?\n/u).filter(Boolean);
  const directUpdate = `${expectedCommit} ${promotedCommit} refs/heads/lastcode/main`;
  const deleteUpdate = `${expectedCommit} ${ZERO_OID} refs/heads/lastcode/main`;
  const createUpdate = `${ZERO_OID} ${promotedCommit} refs/heads/lastcode/main`;
  const headUpdate = `${ZERO_OID} ref:refs/heads/lastcode/main HEAD`;
  const update = updates.find((line) => line.endsWith(" refs/heads/lastcode/main"));
  const state = NodeFS.existsSync(statePath) ? NodeFS.readFileSync(statePath, "utf8").trim() : "";

  if (phase === "prepared") {
    if (update === directUpdate) NodeFS.writeFileSync(statePath, "direct-prepared\n");
    else if (update === deleteUpdate) NodeFS.writeFileSync(statePath, "delete-prepared\n");
    else if (
      update === createUpdate &&
      (state === "deleted" || runGit(worktree, ["rev-parse", "HEAD"]) === expectedCommit)
    ) {
      NodeFS.writeFileSync(statePath, "create-prepared\n");
    } else if (
      updates.includes(headUpdate) &&
      state === "done" &&
      runGit(worktree, ["rev-parse", "refs/heads/lastcode/main"]) === promotedCommit
    ) {
      NodeFS.writeFileSync(statePath, "head-prepared\n");
    } else if (
      state === "done" &&
      updates.every((line) => {
        const [oldValue, newValue] = line.split(" ");
        return oldValue === newValue;
      })
    ) {
      // Git may clear optional pseudorefs through a no-op transaction.
    } else {
      fail("Primary LastCode branch changed before checkout refresh.");
    }
  } else if (phase === "committed") {
    if (update === deleteUpdate && state === "delete-prepared") {
      NodeFS.writeFileSync(statePath, "deleted\n");
    } else if (
      (update === directUpdate && state === "direct-prepared") ||
      (update === createUpdate && state === "create-prepared")
    ) {
      NodeFS.writeFileSync(statePath, "done\n");
    } else if (updates.includes(headUpdate) && state === "head-prepared") {
      NodeFS.writeFileSync(statePath, "done\n");
    }
    return;
  } else {
    return;
  }
  const headPath = NodePath.resolve(
    worktree,
    runGit(worktree, ["rev-parse", "--git-path", "HEAD"]),
  );
  const head = NodeFS.readFileSync(headPath, "utf8").trim();
  if (head !== "ref: refs/heads/lastcode/main") {
    fail(
      `Primary LastCode checkout changed branches before refresh; found '${head || "missing HEAD"}'.`,
    );
  }
}

export async function refreshPrimaryCheckoutTransaction(
  worktree,
  previousCommit,
  promotedCommit,
  options = {},
) {
  await options.beforeCheckout?.();
  const hookDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-checkout-hooks-"),
  );
  try {
    const hookPath = NodePath.join(hookDirectory, "reference-transaction");
    NodeFS.symlinkSync(NodeURL.fileURLToPath(import.meta.url), hookPath);
    const environment = {
      ...process.env,
      [EXPECTED_ENV]: previousCommit,
      [PROMOTED_ENV]: promotedCommit,
      [STATE_ENV]: NodePath.join(hookDirectory, "state"),
      [WORKTREE_ENV]: worktree,
    };
    runGit(
      worktree,
      [
        "-c",
        `core.hooksPath=${hookDirectory}`,
        "checkout",
        "--no-overwrite-ignore",
        "--no-recurse-submodules",
        "-B",
        "lastcode/main",
        promotedCommit,
      ],
      environment,
    );
  } finally {
    NodeFS.rmSync(hookDirectory, { force: true, recursive: true });
  }
}

async function main() {
  if (process.argv[1] && NodePath.basename(process.argv[1]) === "reference-transaction") {
    guardReferenceTransaction(process.argv[2], NodeFS.readFileSync(0, "utf8"));
    return;
  }
  const [worktree, previousCommit, promotedCommit, extra] = process.argv.slice(2);
  if (!worktree || !previousCommit || !promotedCommit || extra) {
    fail("Usage: lastcode-primary-checkout-transaction.mjs <worktree> <previous> <promoted>");
  }
  await refreshPrimaryCheckoutTransaction(worktree, previousCommit, promotedCommit);
}

const isReferenceTransactionHook =
  process.argv[1] && NodePath.basename(process.argv[1]) === "reference-transaction";
if (
  process.argv[1] &&
  (isReferenceTransactionHook || import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
