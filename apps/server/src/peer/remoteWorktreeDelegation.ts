import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const validateRemoteWorktreePreparation = Effect.fn("validateRemoteWorktreePreparation")(
  function* (input: {
    readonly remotePreparation?:
      | {
          readonly worktreeBaseCommit?: string | undefined;
          readonly existingThreadId?: ThreadId | undefined;
        }
      | undefined;
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  }) {
    const isolated = input.remotePreparation?.worktreeBaseCommit !== undefined;
    if (
      isolated &&
      (input.workspaceStrategy !== undefined ||
        input.remotePreparation?.existingThreadId !== undefined)
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "An isolated remote task prepares a new thread from its exact base commit.",
      });
    }

    // Conflicting options must be refused before existing-thread dispatch. Scratch
    // validation waits for project selection, which skips an accepted launch replay.
    return (projectId: ProjectId | undefined) =>
      !isolated || projectId === undefined
        ? Effect.void
        : ManagedProjectFolders.ManagedProjectFolders.pipe(
            Effect.flatMap((folders) => folders.isScratchProject(projectId)),
            Effect.flatMap((scratch) =>
              scratch
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message:
                        "An isolated remote task needs a Git project. Pick a destination project that can fetch the parent commit, or omit isolation.",
                    }),
                  )
                : Effect.void,
            ),
          );
  },
);

export const resolveParentWorktreeBase = Effect.fn("resolveParentWorktreeBase")(function* (
  thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">,
  projects: Pick<ProjectService.ProjectService["Service"], "getById">,
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "resolveCommit">,
) {
  const invalidBase = new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "Unable to resolve the parent checkout commit. Check out a Git commit before delegating, or omit isolation.",
  });
  const project = yield* projects.getById(thread.projectId).pipe(
    Effect.mapError(() => invalidBase),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(invalidBase),
        onSome: Effect.succeed,
      }),
    ),
  );
  const base = yield* git
    .resolveCommit({
      cwd: thread.worktreePath ?? project.workspaceRoot,
      revision: "HEAD",
    })
    .pipe(Effect.mapError(() => invalidBase));
  return base.commitSha;
});
