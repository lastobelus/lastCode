import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@t3tools/contracts";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as SuspensionRegistryTestkit from "../workspace/WorktreeSuspensionRegistry.testkit.ts";
import * as SuspensionRegistry from "../workspace/WorktreeSuspensionRegistry.ts";

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect.each(
    (["suspended", "keep"] as const).flatMap((protection) =>
      (["clear", "occupied", "relinked", "other-owner"] as const).map((boundary) => ({
        protection,
        boundary,
      })),
    ),
  )(
    "retains a $protection checkout during missing-checkout recreation: $boundary",
    ({ protection, boundary }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-recreate-" }),
        );
        const cwd = `${root}/repo`;
        const protectedPath = `${root}/protected`;
        const missingPath = `${root}/missing`;
        yield* fs.makeDirectory(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const execute = (args: string[]) =>
          driver.execute({ operation: "test.recreate", cwd, args });
        for (const args of [
          ["init", "-b", "main"],
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
          ["worktree", "add", "-b", "protected", protectedPath],
          ["worktree", "add", "-b", "missing", missingPath],
          ["update-ref", "refs/t3/saved-workspaces/protected", "HEAD"],
        ])
          yield* execute(args);
        const gitLink = yield* fs.readFileString(`${missingPath}/.git`);
        if (boundary === "other-owner")
          yield* execute(["worktree", "add", "--force", `${root}/other-owner`, "missing"]);
        yield* fs.remove(protectedPath, { recursive: true });
        yield* fs.remove(missingPath, { recursive: true });
        let noteCreated = false;
        const workflowDriver: GitVcsDriver.GitVcsDriver["Service"] = {
          ...driver,
          execute: (input) =>
            driver.execute(input).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (
                    (boundary === "occupied" || boundary === "relinked") &&
                    !noteCreated &&
                    input.args[0] === "worktree" &&
                    input.args[1] === "list"
                  ) {
                    yield* fs.makeDirectory(missingPath);
                    if (boundary === "relinked")
                      yield* fs.writeFileString(`${missingPath}/.git`, gitLink);
                    yield* fs.writeFileString(
                      `${missingPath}/notes.txt`,
                      "New work from an external editor",
                    );
                    noteCreated = true;
                  }
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        operation: "test.recreate",
                        command: "fixture late workspace creation",
                        detail: "Could not create late fixture notes",
                        cwd,
                        cause,
                      }),
                  ),
                ),
              ),
            ),
        };
        const record: SuspensionRegistry.CheckoutAuthority = {
          checkoutId: "protected",
          repositoryRoot: cwd,
          path: protectedPath,
          aliases: [protectedPath],
          owners: [],
          history: [],
          blockedReason: null,
          summary: {
            checkoutId: "protected",
            generation: 0,
            state: protection === "suspended" ? "suspended" : "active",
            snapshotId: null,
            lastRestoredAt: null,
            keepWorkspace: protection === "keep",
          },
        };
        yield* Effect.gen(function* () {
          const workflow = yield* GitWorkflowService.GitWorkflowService;
          assert.equal((yield* Effect.result(workflow.pruneWorktrees({ cwd })))._tag, "Failure");
          const recreated = yield* Effect.result(
            workflow.createWorktree({ cwd, refName: "missing", path: missingPath }),
          );
          if (boundary === "clear") {
            assert.equal(recreated._tag, "Success");
            assert.isTrue(yield* fs.exists(`${missingPath}/.git`));
          } else {
            if (boundary === "occupied" || boundary === "relinked") {
              assert.isTrue(noteCreated);
              assert.equal(
                yield* fs.readFileString(`${missingPath}/notes.txt`),
                "New work from an external editor",
              );
              if (boundary === "relinked")
                assert.equal(yield* fs.readFileString(`${missingPath}/.git`), gitLink);
              else assert.isFalse(yield* fs.exists(`${missingPath}/.git`));
            } else {
              assert.isFalse(yield* fs.exists(`${missingPath}/.git`));
              assert.isTrue(yield* fs.exists(`${root}/other-owner/.git`));
            }
            assert.equal(recreated._tag, "Failure");
          }
          assert.equal(
            (yield* Effect.result(
              workflow.createWorktree({ cwd, refName: "protected", path: protectedPath }),
            ))._tag,
            "Failure",
          );
          assert.isFalse(yield* fs.exists(protectedPath));
          const registered = (yield* execute([
            "worktree",
            "list",
            "--porcelain",
            "-z",
          ])).stdout.split("\0");
          assert.include(registered, `worktree ${protectedPath}`);
          assert.include(registered, `worktree ${missingPath}`);
          assert.equal(
            (yield* execute(["rev-parse", "refs/t3/saved-workspaces/protected"])).stdout,
            (yield* execute(["rev-parse", "protected"])).stdout,
          );
        }).pipe(
          Effect.provide(
            GitWorkflowService.layer.pipe(
              Layer.provide(WorkspaceAcquisitionTestkit.layer),
              Layer.provide(
                Layer.mock(SuspensionRegistry.WorktreeSuspensionRegistry)({
                  root: `${root}/saved`,
                  list: Effect.succeed([record]),
                  automaticProtection: (target) =>
                    Effect.succeed(target === protectedPath ? "Protected" : null),
                }),
              ),
              Layer.provide(
                Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                  resolve: () =>
                    Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
                }),
              ),
              Layer.provide(
                Layer.mock(GitManager.GitManager)({ createWorktree: driver.createWorktree }),
              ),
              Layer.provide(Layer.succeed(GitVcsDriver.GitVcsDriver, workflowDriver)),
            ),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          GitVcsDriver.layer.pipe(
            Layer.provide(VcsProcess.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-recreate-" })),
          ),
        ),
      ),
  );
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(WorkspaceAcquisitionTestkit.layer),
          Layer.provide(SuspensionRegistryTestkit.layer),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
