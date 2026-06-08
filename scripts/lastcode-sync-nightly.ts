#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import {
  LastCodeNightlyError,
  resolveLatestLocalNightlyTag,
  resolveRepoRoot,
  runGit,
} from "./lastcode-nightly.ts";

interface SyncOptions {
  readonly branch: string;
  readonly remote: string;
  readonly pushRemote: string;
  readonly fetch: boolean;
  readonly push: boolean;
  readonly dryRun: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): SyncOptions {
  let branch = "lastcode/main";
  let remote = "upstream";
  let pushRemote = "origin";
  let fetch = true;
  let push = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--branch") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --branch.");
      branch = value;
      index += 1;
    } else if (arg === "--remote") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --remote.");
      remote = value;
      index += 1;
    } else if (arg === "--push-remote") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --push-remote.");
      pushRemote = value;
      index += 1;
    } else if (arg === "--no-fetch") {
      fetch = false;
    } else if (arg === "--push") {
      push = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  return { branch, remote, pushRemote, fetch, push, dryRun };
}

const assertCleanWorktree = Effect.fn("lastcode.assertCleanWorktree")(function* (repoRoot: string) {
  const status = yield* runGit(repoRoot, ["status", "--porcelain"]);
  if (status.length > 0) {
    return yield* new LastCodeNightlyError({
      message: `Working tree must be clean before syncing.\n${status}`,
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

  if (!options.dryRun) {
    yield* assertCleanWorktree(repoRoot);
  }

  if (options.fetch) {
    yield* Console.log(`[lastcode] Fetching ${options.remote} tags...`);
    if (!options.dryRun) {
      yield* runGit(repoRoot, ["fetch", options.remote, "--prune", "--tags"]);
    }
  }

  const latest = yield* resolveLatestLocalNightlyTag(repoRoot);
  const currentBranch = yield* runGit(repoRoot, ["branch", "--show-current"]);

  yield* Console.log(`[lastcode] Latest upstream nightly: ${latest.tag}`);
  yield* Console.log(`[lastcode] Sync branch: ${options.branch}`);

  if (options.dryRun) {
    yield* Console.log(
      `[lastcode] Would switch from ${currentBranch || "detached HEAD"} to ${options.branch}.`,
    );
    yield* Console.log(`[lastcode] Would rebase ${options.branch} onto ${latest.tag}.`);
    if (options.push) {
      yield* Console.log(`[lastcode] Would push ${options.branch} to ${options.pushRemote}.`);
    }
    return;
  }

  if (currentBranch !== options.branch) {
    yield* runGit(repoRoot, ["switch", options.branch]);
  }

  yield* runGit(repoRoot, ["rebase", latest.tag]);

  if (options.push) {
    yield* runGit(repoRoot, ["push", "--force-with-lease", options.pushRemote, options.branch]);
  }

  yield* Console.log(`[lastcode] ${options.branch} is based on ${latest.tag}.`);
});

if (import.meta.main) {
  main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
