// @effect-diagnostics nodeBuiltinImport:off -- Host-side Git coordination uses synchronous subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const MAIN_WRITE_LOCK_REF = "refs/lastcode/main-write-lock";

export function acquireMainWriteLock(
  repoRoot: string,
  remote: string,
  sourceCommit: string,
  operation: "checkpoint" | "merge",
) {
  const command = (
    program: string,
    args: ReadonlyArray<string>,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) =>
    NodeChildProcess.spawnSync(program, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_AUTHOR_NAME: "LastCode automation",
        GIT_AUTHOR_EMAIL: "automation@example.invalid",
        GIT_COMMITTER_NAME: "LastCode automation",
        GIT_COMMITTER_EMAIL: "automation@example.invalid",
        ...environment,
      },
      maxBuffer: 8 * 1024 * 1024,
    });
  const git = (args: ReadonlyArray<string>) => {
    const result = command("git", args);
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message ?? result.stderr.trim() ?? "Git failed.");
    }
    return result.stdout.trim();
  };
  const tree = git(["rev-parse", `${sourceCommit}^{tree}`]);
  const owner = git([
    "-c",
    "user.name=LastCode automation",
    "-c",
    "user.email=automation@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    tree,
    // The remote already has this source. An orphan owner resends its entire tree.
    "-p",
    sourceCommit,
    "-m",
    `LastCode main write: ${operation}\nSource: ${sourceCommit}\nOwner: ${NodeCrypto.randomUUID()}`,
  ]);
  const identity = `${MAIN_WRITE_LOCK_REF} on ${remote} (operation ${operation}, owner ${owner})`;
  const acquired = command("git", [
    "push",
    "--no-verify",
    `--force-with-lease=${MAIN_WRITE_LOCK_REF}:`,
    remote,
    `${owner}:${MAIN_WRITE_LOCK_REF}`,
  ]);
  if (acquired.error || acquired.status !== 0) {
    throw new Error(
      `Could not acquire main write lock ${identity}. Another writer may be active; inspect the remote lock before retrying. Never remove it based on age.\n${acquired.error?.message ?? acquired.stderr.trim()}`,
    );
  }
  let uncertain = false;
  let released = false;
  const assertActive = () => {
    if (released || uncertain) throw new Error(`Main write lock is not available: ${identity}.`);
  };
  return {
    push(args: ReadonlyArray<string>): void {
      assertActive();
      if (args[0] !== "push") throw new Error("Main write lock push requires git push arguments.");
      const hookReceipt = args.includes("--no-verify")
        ? undefined
        : NodePath.join(
            git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
            `lastcode-main-write-hook-${owner}-${NodeCrypto.randomUUID()}`,
          );
      uncertain = true;
      try {
        const result = command("git", ["push", "--porcelain", ...args.slice(1)], {
          LASTCODE_MAIN_WRITE_HOOK_RECEIPT: hookReceipt,
        });
        if (!result.error && result.status === 0) {
          uncertain = false;
          return;
        }
        let hookRejected = false;
        if (hookReceipt) {
          try {
            hookRejected = NodeFS.readFileSync(hookReceipt, "utf8") === "rejected\n";
          } catch {
            // Missing proof leaves the write outcome uncertain.
          }
        }
        const updates = result.stdout.split("\n").filter((line) => /^[!=*+ -]\t/u.test(line));
        // A rejected local hook or rejected-only ref report proves no write landed.
        if (
          !result.error &&
          !result.signal &&
          result.status === 1 &&
          (hookRejected ||
            (updates.some((line) => line.startsWith("!\t")) &&
              updates.every((line) =>
                /^(?:!\t[^\n\t]*\t\[(?:remote )?rejected\]|=\t)/u.test(line),
              )))
        ) {
          uncertain = false;
        }
        throw new Error(
          `Checkpoint push failed under ${identity}.\n${result.error?.message ?? result.stderr.trim()}\n${result.stdout ?? ""}`,
        );
      } finally {
        if (hookReceipt) NodeFS.rmSync(hookReceipt, { force: true });
      }
    },
    merge(args: ReadonlyArray<string>): void {
      assertActive();
      uncertain = true;
      const result = command("gh", args);
      if (result.error || result.status !== 0) {
        throw new Error(
          `PR merge outcome is uncertain under ${identity}.\n${result.error?.message ?? result.stderr.trim()}`,
        );
      }
      const repository = args[args.indexOf("--repo") + 1];
      const expectedHead = args[args.indexOf("--match-head-commit") + 1];
      const number = args[2];
      if (args[0] !== "pr" || args[1] !== "merge" || !repository || !expectedHead || !number) {
        throw new Error(`Cannot confirm PR merge completion under ${identity}.`);
      }
      const confirmation = command("gh", [
        "pr",
        "view",
        number,
        "--repo",
        repository,
        "--json",
        "state,headRefOid",
      ]);
      if (confirmation.error || confirmation.status !== 0) {
        throw new Error(`Cannot confirm PR merge completion under ${identity}.`);
      }
      const completed = JSON.parse(confirmation.stdout) as { state?: string; headRefOid?: string };
      if (completed.state !== "MERGED" || completed.headRefOid !== expectedHead) {
        throw new Error(`PR merge has not completed at the expected head under ${identity}.`);
      }
      uncertain = false;
    },
    release(): void {
      if (released) return;
      if (uncertain) {
        throw new Error(
          `Retained main write lock ${identity}: the write outcome is uncertain. Verify the writer has stopped and the remote write outcome before removing this exact owner; do not retry or steal the lock automatically.`,
        );
      }
      const result = command("git", [
        "push",
        "--no-verify",
        `--force-with-lease=${MAIN_WRITE_LOCK_REF}:${owner}`,
        remote,
        `:${MAIN_WRITE_LOCK_REF}`,
      ]);
      if (result.error || result.status !== 0) {
        throw new Error(
          `Could not release main write lock ${identity}; inspect its current owner.\n${result.error?.message ?? result.stderr.trim()}`,
        );
      }
      released = true;
    },
  };
}
