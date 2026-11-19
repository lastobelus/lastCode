import { expect, it } from "@effect/vitest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as ForgejoCli from "./ForgejoCli.ts";

it.effect("uses the requested web origin when both remotes share a host and path", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const target = yield* cli.resolveRepository({
      cwd: "/repo",
      host: "forgejo.test",
      repository: "team/repo",
      webOrigin: "http://forgejo.test",
    });
    expect(target).toMatchObject({ baseUrl: "http://forgejo.test", repository: "team/repo" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP")),
        ),
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(
                JSON.stringify({
                  hosts: { "forgejo.test": { type: "Application", token: "fixture-token" } },
                }),
              ),
          }),
        ),
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              if (input.command === "git") {
                return Effect.succeed(
                  TestSourceControlHost.processOutput(
                    [
                      "origin\thttp://forgejo.test/team/repo.git (fetch)",
                      "upstream\thttps://forgejo.test/team/repo.git (fetch)",
                    ].join("\n"),
                  ),
                );
              }
              expect(input.args).toEqual(["--host", "http://forgejo.test", "whoami"]);
              return Effect.succeed(TestSourceControlHost.processOutput(""));
            },
          },
        }),
      ),
    ),
  ),
);
