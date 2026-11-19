import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import * as LastCodeRepositoryIdentityResolver from "./LastCodeRepositoryIdentityResolver.ts";

it.live("refines an origin through its own remote and retains the web address", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const git = (args: ReadonlyArray<string>) =>
      runner.run({ command: "git", args: ["-C", cwd, ...args] });
    const originUrl = "git@fork-ssh.invalid:fork/Repo.git";

    yield* git(["init"]);
    yield* git(["remote", "add", "upstream", "https://github.com/upstream/repo.git"]);
    yield* git(["remote", "add", "origin", originUrl]);
    const resolver = yield* LastCodeRepositoryIdentityResolver.make({
      refine: (identity) =>
        Effect.sync(() => {
          if (identity.locator.remoteName !== "origin") return identity;
          expect(identity.locator.remoteUrl).toBe(originUrl);
          expect(identity.rootPath).toBeDefined();
          expect(identity.provider).toBe("unknown");
          return {
            ...identity,
            provider: SourceControlProviderKind.make("forgejo"),
            webUrl: "https://forge.example.test:8443/fork/Repo",
          };
        }),
    });

    expect(yield* resolver.resolve(cwd)).toMatchObject({
      canonicalKey: "github.com/upstream/repo",
      provider: "github",
      origin: {
        canonicalKey: "fork-ssh.invalid/fork/repo",
        remoteUrl: originUrl,
        displayName: "fork/Repo",
        provider: "forgejo",
        webUrl: "https://forge.example.test:8443/fork/Repo",
      },
    });
  }).pipe(Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
);
