#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  LastCodeNightlyError,
  resolveLatestLocalNightlyTag,
  resolveRepoRoot,
  runGit,
  versionFromNightlyTag,
} from "./lastcode-nightly.ts";

interface BuildOptions {
  readonly fetch: boolean;
  readonly outputDir: string;
  readonly verbose: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): BuildOptions {
  let fetch = true;
  let outputDir = "release-lastcode";
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--no-fetch") {
      fetch = false;
    } else if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --output-dir.");
      outputDir = value;
      index += 1;
    } else if (arg === "--verbose") {
      verbose = true;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  return { fetch, outputDir, verbose };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runBuildCommand = Effect.fn("lastcode.runBuildCommand")(function* (
  repoRoot: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("node", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        T3CODE_DESKTOP_UPDATE_REPOSITORY:
          process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY ?? "lastobelus/lastCode",
      },
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (stdout.trim().length > 0) {
    yield* Console.log(stdout.trim());
  }
  if (stderr.trim().length > 0) {
    yield* Console.error(stderr.trim());
  }
  if (exitCode !== 0) {
    return yield* new LastCodeNightlyError({
      message: `LastCode macOS build failed with exit code ${exitCode}.`,
    });
  }
});

const parseCliOptions = Effect.try({
  try: () => parseArgs(process.argv.slice(2)),
  catch: (cause) =>
    new LastCodeNightlyError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
});

const main = Effect.gen(function* () {
  const options = yield* parseCliOptions;
  const repoRoot = yield* resolveRepoRoot();

  if (options.fetch) {
    yield* runGit(repoRoot, ["fetch", "upstream", "--prune", "--tags"]);
  }

  const latest = yield* resolveLatestLocalNightlyTag(repoRoot);
  const version = versionFromNightlyTag(latest.tag);
  yield* Console.log(`[lastcode] Building Apple Silicon LastCode artifact for ${latest.tag}.`);

  yield* runBuildCommand(repoRoot, [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    "arm64",
    "--build-version",
    version,
    "--output-dir",
    options.outputDir,
    ...(options.verbose ? ["--verbose"] : []),
  ]);
});

if (import.meta.main) {
  main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
