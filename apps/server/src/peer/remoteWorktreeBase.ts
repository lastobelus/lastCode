import { type GitCommandError, RemoteWorktreeBaseCommit } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { parseRemoteNamesInGitOrder } from "../git/remoteRefs.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { FETCH_REMOTE_TIMEOUT_MS } from "../vcs/GitVcsDriverCore.ts";

const isCommitId = Schema.is(RemoteWorktreeBaseCommit);

export class RemoteWorktreeBaseError extends Schema.TaggedError<RemoteWorktreeBaseError>()(
  "RemoteWorktreeBaseError",
  { message: Schema.String },
) {}

export const fetchRemoteWorktreeBase = Effect.fn("fetchRemoteWorktreeBase")(function* (
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute" | "resolveCommit">,
  cwd: string,
  commit: string,
) {
  if (!isCommitId(commit))
    return yield* new RemoteWorktreeBaseError({
      message: "A remote worktree needs an exact Git commit ID.",
    });
  const invalidBase = new RemoteWorktreeBaseError({
    message: `The destination project could not fetch parent commit ${commit} from its Git remotes. Push the branch to a remote the destination project can fetch from, or omit isolation.`,
  });
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
  const fetch = (remote: string, refspec: string) =>
    tryFetch(
      git.execute({
        operation: "remoteWorktree.fetch",
        cwd,
        args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remote, refspec],
        timeoutMs: FETCH_REMOTE_TIMEOUT_MS,
      }),
    );
  for (const remote of parseRemoteNamesInGitOrder(remotes.stdout)) {
    if (Option.isSome(yield* fetch(remote, commit))) {
      const resolved = yield* git.resolveCommit({ cwd, revision: commit }).pipe(Effect.option);
      if (Option.isSome(resolved) && resolved.value.commitSha === commit) return;
    }
    // Some servers only allow fetching advertised refs. A detached commit can
    // be on any branch, including one that the destination has never fetched.
    const tracking = `refs/remotes/${remote}/`;
    if (Option.isNone(yield* fetch(remote, `+refs/heads/*:${tracking}*`))) continue;
    const candidates = yield* git
      .execute({
        operation: "remoteWorktree.branchesContainingCommit",
        cwd,
        args: ["for-each-ref", "--format=%(objectname)", "--contains", commit, tracking],
      })
      .pipe(Effect.option);
    if (Option.isNone(candidates) || candidates.value.stdout.trim().length === 0) continue;
    const tips = new Set(candidates.value.stdout.trim().split("\n"));
    // Ignore stale tracking refs left by a branch deletion or force-push.
    const advertised = yield* tryFetch(
      git.execute({
        operation: "remoteWorktree.advertisedBranches",
        cwd,
        args: ["ls-remote", "--heads", "--", remote],
        timeoutMs: FETCH_REMOTE_TIMEOUT_MS,
      }),
    );
    if (
      Option.isSome(advertised) &&
      advertised.value.stdout.split("\n").some((entry) => tips.has(entry.split("\t", 1)[0]!))
    )
      return;
  }
  return yield* timedOut
    ? new RemoteWorktreeBaseError({
        message: `Fetching parent commit ${commit} timed out on the destination. Retry when its Git remote is reachable, or omit isolation.`,
      })
    : invalidBase;
});
