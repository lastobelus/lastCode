import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type ThreadId,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as WorkspaceAcquisition from "../workspace/WorkspaceAcquisition.ts";
import * as SuspensionRegistry from "../workspace/WorktreeSuspensionRegistry.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const workspaceAcquisition = yield* WorkspaceAcquisition.WorkspaceAcquisition;
  const suspensionRegistry = yield* SuspensionRegistry.WorktreeSuspensionRegistry;
  const path = yield* Path.Path;
  const assertCleanupAvailable = Effect.fn("GitWorkflowService.assertCleanupAvailable")(function* (
    operation: string,
    cwd: string,
    target: string,
    prune = false,
  ) {
    const fail = (cause?: unknown) =>
      new GitCommandError({
        operation,
        command: "workspace-retention",
        cwd,
        detail: "Saved workspace data or Keep workspace protection prevents this operation.",
        ...(cause === undefined ? {} : { cause }),
      });
    return yield* Effect.gen(function* () {
      if ((yield* suspensionRegistry.automaticProtection(target)) !== null) return yield* fail();
      if (!prune) return;
      const protectedEntries = (yield* suspensionRegistry.list).filter(
        (entry) =>
          entry.summary.keepWorkspace ||
          (entry.summary.state !== "active" && entry.summary.state !== "discarded"),
      );
      if (protectedEntries.length === 0) return;
      const commonRepository = Effect.fn("GitWorkflowService.cleanupCommonRepository")(function* (
        root: string,
      ) {
        const result = yield* git.execute({
          operation,
          cwd: root,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          maxOutputBytes: 64 * 1024,
        });
        const common = result.stdout.trim();
        if (result.stdoutTruncated || !path.isAbsolute(common) || common.includes("\n"))
          return yield* fail();
        return yield* fileSystem.realPath(common);
      });
      const repository = yield* commonRepository(cwd);
      for (const root of new Set(protectedEntries.map((entry) => entry.repositoryRoot)))
        if ((yield* commonRepository(root)) === repository) return yield* fail();
    }).pipe(Effect.mapError((cause) => fail(cause)));
  });

  const acquireMutation = Effect.fn("GitWorkflowService.acquireMutation")(function* <
    Input extends { readonly cwd: string; readonly threadId?: ThreadId | undefined },
    A,
    E,
    R,
  >(operation: string, input: Input, run: (input: Input) => Effect.Effect<A, E, R>) {
    return yield* withWorkspaceLease(
      input.cwd,
      Effect.gen(function* () {
        const acquired = yield* workspaceAcquisition
          .acquire({
            path: input.cwd,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            purpose: "git-mutation",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation,
                  command: "workspace-acquisition",
                  cwd: input.cwd,
                  detail: "The workspace must be restored before Git can modify it.",
                  cause,
                }),
            ),
          );
        return yield* withWorkspaceLease(acquired.path, run({ ...input, cwd: acquired.path }));
      }),
    );
  });

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      if (handle.kind !== "git") {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
        });
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    isRepository: (cwd) =>
      registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      ),
    hasCommit: (input) =>
      ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      ),
    hasRefNamed: (input) =>
      // Pattern characters would widen the ref match.
      /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          ),
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      acquireMutation("GitWorkflowService.pullCurrentBranch", { cwd }, (input) =>
        ensureGitCommand("GitWorkflowService.pullCurrentBranch", input.cwd).pipe(
          Effect.andThen(git.pullCurrentBranch(input.cwd)),
        ),
      ),
    runStackedAction: (input, options) =>
      acquireMutation("GitWorkflowService.runStackedAction", input, (input) =>
        ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.featureBranch
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.runStackedAction(input, options),
                )
              : gitManager.runStackedAction(input, options),
          ),
        ),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: (input) =>
      acquireMutation("GitWorkflowService.preparePullRequestThread", input, (input) =>
        ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        ),
      ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input, options) =>
      acquireMutation("GitWorkflowService.createWorktree", input, (input) =>
        Effect.gen(function* () {
          yield* ensureGitCommand("GitWorkflowService.createWorktree", input.cwd);
          if (input.path == null) return yield* gitManager.createWorktree(input, options);
          const target = path.resolve(input.cwd, input.path);
          return yield* withWorkspaceLease(
            target,
            Effect.gen(function* () {
              yield* assertCleanupAvailable("GitWorkflowService.createWorktree", input.cwd, target);
              let reuseMissingRegistrationAt: string | undefined;
              if (!(yield* fileSystem.exists(target))) {
                const registered = yield* git.execute({
                  operation: "GitWorkflowService.createWorktree",
                  cwd: input.cwd,
                  args: ["worktree", "list", "--porcelain", "-z"],
                });
                const registrations = registered.stdout
                  .split("\0\0")
                  .map((entry) => entry.split("\0"));
                const branchField = `branch refs/heads/${input.refName}`;
                const targetField = `worktree ${target}`;
                const staleRegistration =
                  !registered.stdoutTruncated &&
                  input.newRefName === undefined &&
                  registrations.every(
                    (fields) => !fields.includes(branchField) || fields.includes(targetField),
                  ) &&
                  registrations.some((fields) => {
                    return (
                      fields.includes(targetField) &&
                      fields.includes(branchField) &&
                      fields.some((field) => field === "prunable" || field.startsWith("prunable "))
                    );
                  });
                if (staleRegistration) {
                  reuseMissingRegistrationAt = target;
                }
              }
              return yield* gitManager.createWorktree(input, {
                ...options,
                reuseMissingRegistrationAt,
              });
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof GitCommandError
                  ? cause
                  : new GitCommandError({
                      operation: "GitWorkflowService.createWorktree",
                      command: "git worktree add",
                      cwd: input.cwd,
                      detail: "git worktree add failed",
                      cause,
                    }),
              ),
            ),
          );
        }),
      ),
    listLocalBranchNames: (cwd) =>
      ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      ),
    fetchRemote: (input) =>
      acquireMutation("GitWorkflowService.fetchRemote", input, (input) =>
        ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
          Effect.andThen(git.fetchRemote(input)),
        ),
      ),
    remoteExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      ),
    remoteBranchExists: (input) =>
      ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    resolveWorktreeBaseRemote: (input) =>
      ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
        Effect.andThen(git.resolveWorktreeBaseRemote(input)),
      ),
    fetchWorktreeBaseCommit: (input) =>
      acquireMutation("GitWorkflowService.fetchWorktreeBaseCommit", input, (input) =>
        ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        ),
      ),
    removeWorktree: (input) =>
      withWorkspaceLease(
        path.resolve(input.cwd, input.path),
        assertCleanupAvailable(
          "GitWorkflowService.removeWorktree",
          input.cwd,
          path.resolve(input.cwd, input.path),
        ).pipe(
          Effect.andThen(ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd)),
          Effect.andThen(git.removeWorktree(input)),
        ),
      ),
    pruneWorktrees: (input) =>
      withWorkspaceLease(
        input.cwd,
        assertCleanupAvailable(
          "GitWorkflowService.pruneWorktrees",
          input.cwd,
          input.cwd,
          true,
        ).pipe(
          Effect.andThen(ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd)),
          Effect.andThen(git.pruneWorktrees(input)),
        ),
      ),
    deleteLocalBranch: (input) =>
      acquireMutation("GitWorkflowService.deleteLocalBranch", input, (input) =>
        ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
          Effect.andThen(git.deleteLocalBranch(input)),
        ),
      ),
    createRef: (input) =>
      acquireMutation("GitWorkflowService.createRef", input, (input) =>
        ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.switchRef
              ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
              : git.createRef(input),
          ),
        ),
      ),
    switchRef: (input) =>
      acquireMutation("GitWorkflowService.switchRef", input, (input) =>
        ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
          Effect.flatMap((handle) =>
            withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
          ),
        ),
      ),
    renameBranch: (input) =>
      acquireMutation("GitWorkflowService.renameBranch", input, (input) =>
        ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
          Effect.andThen(git.renameBranch(input)),
        ),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
