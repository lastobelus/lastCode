import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { installProjectRootGuard, PROJECT_ROOT_GUARD_OVERRIDE_ENV } from "./ProjectRootGuard.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-root-guard-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const isolatedGitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({
        operation: "ProjectRootGuard.test.git",
        cwd,
        args,
        env: { ...isolatedGitEnv, ...env },
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      }),
    ),
  );

const head = (cwd: string) =>
  git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"]).pipe(Effect.map((r) => r.stdout.trim()));

it.live("keeps a project's main checkout on its default branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-root-guard-" });
      const root = path.join(base, "root");
      yield* fileSystem.makeDirectory(root);
      yield* git(root, ["init", "-q", "-b", "trunk"]);
      yield* git(root, ["config", "user.name", "Test"]);
      yield* git(root, ["config", "user.email", "test@example.com"]);
      yield* fileSystem.writeFileString(path.join(root, "tracked"), "x\n");
      yield* git(root, ["add", "tracked"]);
      yield* git(root, ["commit", "-q", "-m", "first"]);
      yield* git(root, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
      yield* git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
      yield* git(root, ["switch", "-q", "-c", "existing"]);
      yield* fileSystem.writeFileString(path.join(root, "only-on-existing"), "x\n");
      yield* git(root, ["add", "only-on-existing"]);
      yield* git(root, ["commit", "-q", "-m", "existing"]);
      yield* git(root, ["switch", "-q", "trunk"]);

      assert.isTrue(yield* installProjectRootGuard(root));

      const refused = yield* git(root, ["switch", "-c", "feature"]);
      assert.notEqual(refused.exitCode, 0);
      assert.include(refused.stderr, "lastcode-root-guard: refused to move");
      assert.include(refused.stderr, "git worktree add <path> -b <branch> origin/trunk");
      assert.equal(yield* head(root), "trunk");
      assert.notEqual((yield* git(root, ["switch", "existing"])).exitCode, 0);
      assert.notEqual((yield* git(root, ["switch", "--orphan", "orphan"])).exitCode, 0);
      // Checkout rewrites files before HEAD; a refused switch must not leave them behind.
      assert.equal((yield* git(root, ["status", "--porcelain"])).stdout, "");
      assert.notEqual((yield* git(root, ["checkout", "--detach"])).exitCode, 0);
      // A rename deletes the checked-out branch before moving HEAD; refuse it up front.
      assert.notEqual((yield* git(root, ["branch", "-m", "renamed"])).exitCode, 0);
      assert.equal((yield* git(root, ["rev-parse", "--verify", "-q", "trunk"])).exitCode, 0);
      const fromApp = yield* GitVcsDriver.GitVcsDriver.pipe(
        Effect.flatMap((driver) => driver.switchRef({ cwd: root, refName: "existing" })),
        Effect.flip,
      );
      assert.equal(fromApp.reason, "ref_update_rejected_by_hook");
      assert.include(fromApp.detail, "worktree");
      assert.equal(yield* head(root), "trunk");

      // Work that keeps HEAD on the default branch, and other worktrees, stays free.
      const worktree = path.join(base, "worktree");
      assert.equal((yield* git(root, ["worktree", "add", worktree, "-b", "side"])).exitCode, 0);
      assert.equal(
        (yield* git(worktree, ["commit", "-q", "--allow-empty", "-m", "w"])).exitCode,
        0,
      );
      assert.equal((yield* git(worktree, ["switch", "existing"])).exitCode, 0);
      assert.equal((yield* git(root, ["commit", "-q", "--allow-empty", "-m", "c"])).exitCode, 0);
      assert.equal((yield* git(root, ["rebase", "side"])).exitCode, 0);
      assert.equal(yield* head(root), "trunk");

      // The visible override, and a way back once a root is on the wrong branch.
      const override = { [PROJECT_ROOT_GUARD_OVERRIDE_ENV]: "1" };
      assert.equal((yield* git(root, ["switch", "-c", "on-purpose"], override)).exitCode, 0);
      assert.equal((yield* git(root, ["switch", "trunk"])).exitCode, 0);

      // Without an upstream default nothing is guarded, so a new local `main` cannot trap the root.
      yield* git(root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      yield* git(root, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
      assert.equal((yield* git(root, ["switch", "-c", "main"])).exitCode, 0);
      assert.equal((yield* git(root, ["switch", "trunk"])).exitCode, 0);

      // Reinstalling keeps a person's opt-out.
      yield* git(root, ["config", "hook.lastcode-root-guard.enabled", "false"]);
      assert.isTrue(yield* installProjectRootGuard(root));
      assert.equal((yield* git(root, ["switch", "on-purpose"])).exitCode, 0);

      assert.isFalse(yield* installProjectRootGuard(worktree));
      const nested = path.join(root, "nested");
      yield* fileSystem.makeDirectory(nested);
      assert.isFalse(yield* installProjectRootGuard(nested));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.live("moves submodules back after refusing a recursive switch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-root-guard-sub-" });
      const lib = path.join(base, "lib");
      const root = path.join(base, "root");
      const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
      const fileProtocol = { GIT_ALLOW_PROTOCOL: "file" };
      yield* git(base, ["init", "-q", "-b", "main", lib]);
      yield* git(lib, [...identity, "commit", "-q", "--allow-empty", "-m", "one"]);
      yield* git(lib, [...identity, "commit", "-q", "--allow-empty", "-m", "two"]);
      yield* git(base, ["init", "-q", "-b", "main", root]);
      yield* git(root, ["submodule", "-q", "add", lib, "module"], fileProtocol);
      const module = path.join(root, "module");
      yield* git(module, ["checkout", "-q", "main~1"]);
      yield* git(root, ["add", "module"]);
      yield* git(root, [...identity, "commit", "-q", "-m", "pin one"]);
      yield* git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      yield* git(root, ["switch", "-q", "-c", "bumped"]);
      yield* git(module, ["checkout", "-q", "main"]);
      yield* git(root, ["add", "module"]);
      yield* git(root, [...identity, "commit", "-q", "-m", "pin two"]);
      yield* git(root, ["switch", "-q", "main"]);
      yield* git(root, ["submodule", "-q", "update"], fileProtocol);
      assert.isTrue(yield* installProjectRootGuard(root));

      const refused = yield* git(root, ["switch", "--recurse-submodules", "bumped"]);
      assert.notEqual(refused.exitCode, 0);
      assert.equal(yield* head(root), "main");
      assert.equal((yield* git(root, ["status", "--porcelain"])).stdout, "");
    }),
  ).pipe(Effect.provide(layerTest)),
);
