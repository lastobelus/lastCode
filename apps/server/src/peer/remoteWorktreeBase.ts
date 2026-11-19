import { type GitCommandError, OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { parseRemoteNamesInGitOrder } from "../git/remoteRefs.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { FETCH_REMOTE_TIMEOUT_MS } from "../vcs/GitVcsDriverCore.ts";

export const remoteWorktreeBaseBranch = Effect.fn("remoteWorktreeBaseBranch")(function* (
  cwd: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const current = yield* git
    .execute({
      operation: "remoteWorktree.currentBranch",
      cwd,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    })
    .pipe(Effect.option);
  if (Option.isNone(current)) return undefined;
  const branch = current.value.stdout.trim();
  const tracked = yield* git
    .resolveWorktreeBaseRemote({ cwd, refName: branch })
    .pipe(Effect.orElseSucceed(() => null));
  return tracked?.branchName ?? branch;
});

export const prepareRemoteWorktreeBase = Effect.fn("prepareRemoteWorktreeBase")(function* (
  project: { readonly id: ProjectId; readonly workspaceRoot: string },
  commit: string,
  branchHint: string | undefined,
) {
  const invalidBase = new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `The destination project could not fetch parent commit ${commit} from its Git remote. Push the branch to a remote the destination project can fetch from, or omit isolation.`,
  });
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  if (yield* folders.isScratchProject(project.id)) return yield* invalidBase;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const cwd = project.workspaceRoot;
  const remotes = yield* git
    .execute({ operation: "remoteWorktree.remotes", cwd, args: ["remote"] })
    .pipe(Effect.mapError(() => invalidBase));
  let timedOut = false;
  const tryFetch = <A>(fetch: Effect.Effect<A, GitCommandError>) =>
    fetch.pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.sync(() => {
          timedOut ||= error.reason === "timed_out";
          return Option.none();
        }),
      ),
    );
  for (const remoteName of parseRemoteNamesInGitOrder(remotes.stdout)) {
    const fetched = yield* tryFetch(
      git.execute({
        operation: "remoteWorktree.fetch",
        cwd,
        // The commit is the base. FETCH_HEAD is shared with other Git operations in this checkout.
        args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remoteName, commit],
        timeoutMs: FETCH_REMOTE_TIMEOUT_MS,
      }),
    );
    if (Option.isSome(fetched)) {
      const resolved = yield* git.resolveCommit({ cwd, revision: commit }).pipe(Effect.option);
      if (Option.isSome(resolved) && resolved.value.commitSha === commit) return;
    }
    // A Git server can refuse an object ID even when it advertises a branch containing it.
    const defaultBranch = yield* git
      .resolveDefaultBranchName(cwd, remoteName)
      .pipe(Effect.orElseSucceed(() => null));
    for (const branchName of new Set([branchHint, defaultBranch])) {
      if (!branchName) continue;
      const valid = yield* git
        .execute({
          operation: "remoteWorktree.checkBranch",
          cwd,
          args: ["check-ref-format", `refs/heads/${branchName}`],
        })
        .pipe(Effect.option);
      if (Option.isNone(valid)) continue;
      const tip = yield* tryFetch(
        git.fetchWorktreeBaseCommit({
          cwd,
          refName: branchName,
          remote: { remoteName, branchName },
        }),
      );
      if (Option.isNone(tip) || tip.value === null) continue;
      const contains = yield* git
        .execute({
          operation: "remoteWorktree.checkAncestor",
          cwd,
          args: ["merge-base", "--is-ancestor", commit, tip.value.commitSha],
        })
        .pipe(Effect.option);
      if (Option.isSome(contains)) return;
    }
  }
  if (timedOut)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Fetching parent commit ${commit} timed out on the destination. Retry when its Git remote is reachable, or omit isolation.`,
    });
  return yield* invalidBase;
});
