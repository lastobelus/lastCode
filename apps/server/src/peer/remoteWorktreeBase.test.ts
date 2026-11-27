import { NodeServices } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { GitCommandError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { fetchRemoteWorktreeBase } from "./remoteWorktreeBase.ts";

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "remote-worktree-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live("fetches a detached parent commit reachable through a non-default branch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "remote-worktree-base-" });
    const remote = `${root}/remote.git`;
    const source = `${root}/source`;
    const destination = `${root}/destination`;
    const run = (cwd: string, ...args: string[]) =>
      git.execute({ operation: "remote-worktree-test", cwd, args });
    yield* run(root, "init", "--bare", "--initial-branch=main", remote);
    yield* run(root, "clone", remote, source);
    yield* run(source, "config", "user.name", "Test");
    yield* run(source, "config", "user.email", "test@example.test");
    yield* run(source, "commit", "--allow-empty", "-m", "Initial");
    yield* run(source, "push", "origin", "main");
    yield* run(root, "clone", `file://${remote}`, destination);
    yield* run(destination, "config", "protocol.version", "0");
    yield* run(source, "switch", "-c", "published");
    yield* run(source, "commit", "--allow-empty", "-m", "Parent base");
    const { commitSha } = yield* git.resolveCommit({ cwd: source, revision: "HEAD" });
    yield* run(source, "commit", "--allow-empty", "-m", "Advance the published branch");
    yield* run(source, "push", "origin", "published");
    yield* run(source, "switch", "--detach", commitSha);

    const direct = yield* run(destination, "fetch", "origin", commitSha).pipe(Effect.result);
    expect(direct._tag).toBe("Failure");
    yield* fetchRemoteWorktreeBase(git, destination, commitSha);
    expect(yield* git.resolveCommit({ cwd: destination, revision: commitSha })).toEqual({
      commitSha,
    });
    const missing = yield* fetchRemoteWorktreeBase(git, destination, "a".repeat(40)).pipe(
      Effect.result,
    );
    expect(missing).toMatchObject({
      _tag: "Failure",
      failure: expect.objectContaining({
        message: expect.stringContaining("Push the branch"),
      }),
    });
  }).pipe(Effect.provide(layerGit)),
);

it.effect("reports a fetch timeout separately from an unavailable commit", () =>
  Effect.gen(function* () {
    const result = yield* fetchRemoteWorktreeBase(
      {
        execute: ({ cwd, args, operation, timeoutMs }) => {
          if (args[0] === "remote") {
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "origin\n",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          expect(timeoutMs).toBe(300_000);
          return Effect.fail(
            new GitCommandError({
              cwd,
              operation,
              command: "git fetch",
              detail: "The fetch timed out.",
              reason: "timed_out",
            }),
          );
        },
        resolveCommit: () => Effect.die("The fetch did not return a commit."),
      },
      "/repo",
      "a".repeat(40),
    ).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: expect.objectContaining({
        message: expect.stringContaining("timed out on the destination"),
      }),
    });
  }),
);
