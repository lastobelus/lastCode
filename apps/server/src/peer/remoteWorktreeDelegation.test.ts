import { ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { remoteWorktreeDispatchMode } from "./remoteOwnership.ts";
import {
  resolveParentWorktreeBase,
  validateRemoteWorktreePreparation,
} from "./remoteWorktreeDelegation.ts";

const worktreeBaseCommit = "a".repeat(40);
const projectId = ProjectId.make("project:repo");

it.effect.each([
  { remotePreparation: { worktreeBaseCommit }, workspaceStrategy: { type: "root" as const } },
  { remotePreparation: { worktreeBaseCommit, existingThreadId: ThreadId.make("existing") } },
])("refuses conflicting isolated preparation options, %j", (input) =>
  Effect.gen(function* () {
    expect(yield* validateRemoteWorktreePreparation(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_request", message: expect.stringContaining("new thread") },
    });
  }),
);

it.effect("checks Scratch only for an isolated launch with a selected project", () =>
  Effect.gen(function* () {
    const checkSharedProject = yield* validateRemoteWorktreePreparation({});
    const checkIsolatedProject = yield* validateRemoteWorktreePreparation({
      remotePreparation: { worktreeBaseCommit },
    });
    yield* checkSharedProject(projectId);
    yield* checkIsolatedProject(undefined);
    const result = yield* checkIsolatedProject(projectId).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_request", message: expect.stringContaining("needs a Git project") },
    });
  }).pipe(
    Effect.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        isScratchProject: () => Effect.succeed(true),
        namedProjectsRoot: "/projects",
      }),
    ),
  ),
);

it.effect.each([null, "/worktrees/source"])(
  "resolves the parent HEAD from checkout %s",
  (worktreePath) =>
    Effect.gen(function* () {
      const project: Project = {
        id: projectId,
        title: "Repo",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      };
      const result = yield* resolveParentWorktreeBase(
        { projectId, worktreePath },
        { getById: () => Effect.succeedSome(project) },
        {
          resolveCommit: ({ cwd, revision }) => {
            expect({ cwd, revision }).toEqual({
              cwd: worktreePath ?? project.workspaceRoot,
              revision: "HEAD",
            });
            return Effect.succeed({ commitSha: worktreeBaseCommit });
          },
        },
      );
      expect(result).toBe(worktreeBaseCommit);
    }),
);

it.effect("refuses a remote worktree when the source project is missing", () =>
  Effect.gen(function* () {
    const result = yield* resolveParentWorktreeBase(
      { projectId, worktreePath: null },
      { getById: () => Effect.succeedNone },
      { resolveCommit: () => Effect.die("A missing project has no checkout to resolve.") },
    ).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "invalid_request",
        message: expect.stringContaining("Check out a Git commit"),
      },
    });
  }),
);

it("defers an isolated activation only for a thread with an unused workspace", () => {
  const empty = { thread: { worktreePath: null }, runs: [] };
  const withRun = { ...empty, runs: [{}] };
  const withWorktree = { ...empty, thread: { worktreePath: "/worktrees/existing" } };
  expect(remoteWorktreeDispatchMode(undefined, withRun)).toMatchObject({
    _tag: "Success",
    success: { type: "queue_after_active" },
  });
  expect(remoteWorktreeDispatchMode(worktreeBaseCommit, empty)).toMatchObject({
    _tag: "Success",
    success: {
      type: "defer_start",
      workspaceStrategy: {
        type: "worktree",
        baseRef: worktreeBaseCommit,
        startFromOrigin: false,
        requireExactBase: true,
      },
    },
  });
  for (const occupied of [withRun, withWorktree]) {
    expect(remoteWorktreeDispatchMode(worktreeBaseCommit, occupied)).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("unused thread"),
    });
  }
});
