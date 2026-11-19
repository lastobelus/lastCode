import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as LastCodeRepositoryIdentityResolver from "./LastCodeRepositoryIdentityResolver.ts";

const fixtureLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeRepository = (upstream: string, origin: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const cwd = yield* fileSystem.makeTempDirectoryScoped();
    const git = (args: ReadonlyArray<string>) =>
      runner.run({ command: "git", args: ["-C", cwd, ...args] });
    yield* git(["init"]);
    yield* git(["remote", "add", "upstream", upstream]);
    yield* git(["remote", "add", "origin", origin]);
    return cwd;
  });

it.live("refines an origin through its own remote and retains the web address", () =>
  Effect.gen(function* () {
    const originUrl = "git@fork-ssh.invalid:fork/Repo.git";
    const cwd = yield* makeRepository("https://github.com/upstream/repo.git", originUrl);
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
  }).pipe(Effect.provide(fixtureLayer)),
);

it.live("keeps origin when the same hostname and repository path use different web ports", () =>
  Effect.gen(function* () {
    const canonicalUrl = "https://forgejo.test/team/repo.git";
    const originUrl = "https://forgejo.test:8443/team/repo.git";
    const cwd = yield* makeRepository(canonicalUrl, originUrl);
    const resolver = yield* LastCodeRepositoryIdentityResolver.make({});

    expect(yield* resolver.resolve(cwd)).toMatchObject({
      canonicalKey: "forgejo.test/team/repo",
      locator: { remoteName: "upstream", remoteUrl: canonicalUrl },
      origin: { canonicalKey: "forgejo.test/team/repo", remoteUrl: originUrl },
    });
  }).pipe(Effect.provide(fixtureLayer)),
);

it.live("keeps a distinct HTTP origin on its default port", () =>
  Effect.gen(function* () {
    const upstream = "https://forgejo.test/team/repo.git";
    const origin = "http://forgejo.test/team/repo.git";
    const cwd = yield* makeRepository(upstream, origin);
    const resolver = yield* LastCodeRepositoryIdentityResolver.make({});
    expect(yield* resolver.resolve(cwd)).toMatchObject({ origin: { remoteUrl: origin } });
  }).pipe(Effect.provide(fixtureLayer)),
);
