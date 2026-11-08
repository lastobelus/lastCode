// @effect-diagnostics nodeBuiltinImport:off - Exercises a scoped shell launcher fixture.
import * as NodeChildProcess from "node:child_process";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TriageService from "./TriageService.ts";
import { pickSourceRef } from "./TriageService.ts";

const MAIN = "a1dc856ee61278d0199c36d4bcdef5fdea4d21fe\trefs/heads/lastcode/main";

it("clones the server's LastCode tag, peeling annotated tags to their commit", () => {
  for (const [version, tag] of [
    ["1.2.3-nightly.20260101.7", "lastcode/checkpoint/v1.2.3-nightly.20260101.7"],
    ["1.2.3-nightly.20260101.7.2", "lastcode/revision/v1.2.3-nightly.20260101.7.2"],
  ] as const) {
    const upstream = `9999999\trefs/tags/v${version}\n`;
    assert.deepEqual(pickSourceRef(`${MAIN}\n${upstream}7027b1f\trefs/tags/${tag}\n`, version), {
      ref: tag,
      commit: "7027b1f",
    });
    assert.deepEqual(
      pickSourceRef(
        `${MAIN}\n${upstream}1111111\trefs/tags/${tag}\n2222222\trefs/tags/${tag}^{}\n`,
        version,
      ),
      { ref: tag, commit: "2222222" },
    );
  }
});

it("falls back to lastcode/main when the server's version has no LastCode tag", () => {
  const upstream = "9999999\trefs/heads/main\n8888888\trefs/tags/v0.1.1\n";
  assert.deepEqual(pickSourceRef(`${MAIN}\n${upstream}`, "0.1.1"), {
    ref: "lastcode/main",
    commit: "a1dc856ee61278d0199c36d4bcdef5fdea4d21fe",
  });
  assert.isUndefined(pickSourceRef("", "0.1.1"));
  assert.isUndefined(pickSourceRef(upstream, "0.1.1"));
});

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3 triage's service-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const RELEASE_COMMIT = "7027b1f";

/** The service over a stub git that answers each command with `answer`. */
const makeTriage = (
  answer: (command: string) => Effect.Effect<string, GitCommandError> = (command) =>
    Effect.succeed(
      command === "ls-remote"
        ? `${RELEASE_COMMIT}\trefs/tags/lastcode/checkpoint/v${packageJson.version}\n`
        : command === "rev-parse"
          ? `${RELEASE_COMMIT}\n`
          : "",
    ),
) =>
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const commands: string[] = [];
    const triage = yield* Layer.build(TriageService.layer).pipe(
      Effect.map(Context.get(TriageService.TriageService)),
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) => {
          const command = input.args[0] ?? "";
          commands.push(command);
          return answer(command).pipe(
            Effect.map((stdout) => ({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          );
        },
      }),
    );
    return { triage, commands };
  });

const readContext = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const sessions = `${config.stateDir}/triage`;
  const [session] = yield* fs.readDirectory(sessions);
  return yield* fs.readFileString(`${sessions}/${session}/context.md`);
});

it.live("offers this environment's custom-home launcher only when it exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const { triage } = yield* makeTriage();
    assert.isTrue(Option.isNone(yield* triage.getCliCommand()));

    yield* fs.makeDirectory(`${config.baseDir}/bin`, { recursive: true });
    yield* fs.writeFileString(`${config.baseDir}/bin/t3`, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const command = Option.getOrThrow(yield* triage.getCliCommand());
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
      env: { ...process.env, T3CODE_HOME: "/home/user/a-different-home" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), ["triage", "--base-dir", config.baseDir]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("sessions started during a clone share it, and a release tag is looked up once", () =>
  Effect.gen(function* () {
    const fetches = yield* Queue.unbounded<void>();
    const { triage, commands } = yield* makeTriage((command) =>
      command === "fetch"
        ? Queue.offer(fetches, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(
            command === "ls-remote"
              ? `${RELEASE_COMMIT}\trefs/tags/lastcode/checkpoint/v${packageJson.version}\n`
              : "",
          ),
    );

    yield* triage.prepare({ client: {} });
    yield* triage.prepare({ client: {} });
    yield* Queue.take(fetches);

    assert.deepEqual(
      commands.filter((command) => command === "ls-remote" || command === "init"),
      ["ls-remote", "init"],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reuses a finished clone without fetching", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${config.baseDir}/source/${RELEASE_COMMIT}/.git`, {
      recursive: true,
    });
    const { triage, commands } = yield* makeTriage();

    yield* triage.prepare({ client: {} });

    assert.deepEqual(commands, ["ls-remote", "rev-parse"]);
    assert.include(yield* readContext, "The server cloned the source for its own version");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("still starts triage when the source lookup fails", () =>
  Effect.gen(function* () {
    const { triage } = yield* makeTriage(() =>
      Effect.fail(
        new GitCommandError({
          operation: "TriageService.resolveSourceRef",
          command: "git ls-remote",
          cwd: "/",
          detail: "Could not resolve host: github.com",
        }),
      ),
    );

    const { prompt } = yield* triage.prepare({ client: {} });

    assert.include(prompt, "triage-playbook.md");
    assert.include(yield* readContext, "Could not resolve host: github.com");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not trust a folder without its own .git, even inside a repo at that commit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${config.baseDir}/source/${RELEASE_COMMIT}`, { recursive: true });
    // The stub answers rev-parse with the commit, as a parent repository could.
    const { triage, commands } = yield* makeTriage();

    yield* triage.prepare({ client: {} });

    assert.notInclude(commands, "rev-parse");
    assert.include(yield* readContext, "is not a complete checkout");
  }).pipe(Effect.provide(TestLayer)),
);
