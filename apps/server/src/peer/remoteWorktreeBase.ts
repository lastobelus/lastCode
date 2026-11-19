import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const prepareRemoteWorktreeBase = Effect.fn("prepareRemoteWorktreeBase")(function* (
  project: { readonly id: ProjectId; readonly workspaceRoot: string },
  commit: string,
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
  for (const remote of remotes.stdout.trim().split("\n").filter(Boolean)) {
    const fetched = yield* git
      .execute({
        operation: "remoteWorktree.fetch",
        cwd,
        // The commit is the base. FETCH_HEAD is shared with other Git operations in this checkout.
        args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remote, commit],
      })
      .pipe(Effect.option);
    if (fetched._tag === "Some") {
      const resolved = yield* git.resolveCommit({ cwd, revision: commit }).pipe(Effect.option);
      if (resolved._tag === "Some" && resolved.value.commitSha === commit) return;
    }
  }
  return yield* invalidBase;
});
