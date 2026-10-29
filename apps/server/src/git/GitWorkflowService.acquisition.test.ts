import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceAcquisition from "../workspace/WorkspaceAcquisition.ts";
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as Registry from "../workspace/WorktreeSuspensionRegistry.ts";

const fixture = (
  acquire: WorkspaceAcquisition.WorkspaceAcquisition["Service"]["acquire"],
  calls: string[],
  protection: string | null = null,
  catalogUnavailable = false,
) =>
  GitWorkflow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        WorkspaceAcquisitionTestkit.layerWith(acquire),
        Layer.mock(Registry.WorktreeSuspensionRegistry)({
          root: "/test/saved-workspaces",
          automaticProtection: () => Effect.succeed(protection),
          list: catalogUnavailable
            ? Effect.fail(new Registry.SuspensionRegistryError({ operation: "read" }))
            : Effect.succeed([]),
        }),
        Layer.mock(GitManager.GitManager)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          pullCurrentBranch: (cwd) =>
            Effect.sync(() => {
              calls.push(`pull:${cwd}`);
              return {} as never;
            }),
          removeWorktree: () =>
            Effect.sync(() => {
              calls.push("remove");
            }),
          pruneWorktrees: () =>
            Effect.sync(() => {
              calls.push("prune");
            }),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: ({ cwd }) =>
            Effect.sync(() => {
              calls.push(`resolve:${cwd}`);
              return { kind: "git" } as VcsDriverRegistry.VcsDriverHandle;
            }),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

it.effect("uses the recovered checkout path before resolving or running a Git mutation", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const git = yield* GitWorkflow.GitWorkflowService;
    yield* git.pullCurrentBranch("/worktrees/example/old");
    assert.deepEqual(calls, [
      "acquire:/worktrees/example/old",
      "resolve:/worktrees/example/restored",
      "pull:/worktrees/example/restored",
    ]);
  }).pipe(
    Effect.provide(
      fixture(
        (input) =>
          Effect.sync(() => {
            assert.equal(input.purpose, "git-mutation");
            calls.push(`acquire:${input.path}`);
            return { path: "/worktrees/example/restored", branch: "recovered", restored: true };
          }),
        calls,
      ),
    ),
  );
});

it.effect("does not run Git when saved workspace acquisition fails", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const git = yield* GitWorkflow.GitWorkflowService;
    const error = yield* git.pullCurrentBranch("/worktrees/example/saved").pipe(Effect.flip);
    assert.equal(error._tag, "GitCommandError");
    assert.instanceOf(error.cause, WorkspaceAcquisition.WorkspaceUnavailableError);
    assert.deepEqual(calls, []);
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          Effect.fail(
            new WorkspaceAcquisition.WorkspaceUnavailableError({ reason: "snapshot-unavailable" }),
          ),
        calls,
      ),
    ),
  );
});

it.effect(
  "retains protected checkouts on raw remove/prune without acquiring or restoring them",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const git = yield* GitWorkflow.GitWorkflowService;
      for (const operation of [
        git.removeWorktree({
          cwd: "/example/repository",
          path: "/worktrees/example/saved",
          force: true,
        }),
        git.pruneWorktrees({ cwd: "/example/repository" }),
      ])
        assert.equal((yield* Effect.result(operation))._tag, "Failure");
      assert.deepEqual(calls, []);
    }).pipe(
      Effect.provide(
        fixture(
          () => Effect.die("Removal must never restore"),
          calls,
          "Keep workspace is enabled.",
        ),
      ),
    );
  },
);

it.effect("does not prune when the recovery catalog cannot be read", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const git = yield* GitWorkflow.GitWorkflowService;
    const error = yield* git.pruneWorktrees({ cwd: "/example/repository" }).pipe(Effect.flip);
    assert.equal(error._tag, "GitCommandError");
    assert.instanceOf(error.cause, Registry.SuspensionRegistryError);
    assert.deepEqual(calls, []);
  }).pipe(Effect.provide(fixture(() => Effect.die("Prune must never restore"), calls, null, true)));
});
