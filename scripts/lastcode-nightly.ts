#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface NightlyTag {
  readonly tag: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly date: number;
  readonly runNumber: number;
}

export class LastCodeNightlyError extends Data.TaggedError("LastCodeNightlyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function parseNightlyTag(tag: string): NightlyTag | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (!match) return undefined;

  const [, major, minor, patch, date, runNumber] = match;
  if (!major || !minor || !patch || !date || !runNumber) return undefined;

  return {
    tag,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    date: Number(date),
    runNumber: Number(runNumber),
  };
}

export function compareNightlyTags(left: NightlyTag, right: NightlyTag): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.date !== right.date) return left.date - right.date;
  return left.runNumber - right.runNumber;
}

export function resolveLatestNightlyTag(tags: ReadonlyArray<string>): NightlyTag | undefined {
  return tags
    .map((tag) => parseNightlyTag(tag))
    .filter((tag): tag is NightlyTag => tag !== undefined)
    .toSorted((left, right) => compareNightlyTags(right, left))[0];
}

export function versionFromNightlyTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

export const runGit = Effect.fn("lastcode.runGit")(function* (
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repoRoot }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode === 0) {
    return stdout.trim();
  }

  if (options.allowFailure) {
    return "";
  }

  const stderrText = stderr.trim();
  const suffix = stderrText ? `\n${stderrText}` : "";
  return yield* new LastCodeNightlyError({
    message: `git ${args.join(" ")} failed.${suffix}`,
  });
});

export const resolveRepoRoot = Effect.fn("lastcode.resolveRepoRoot")(function* (
  cwd = process.cwd(),
) {
  const path = yield* Path.Path;
  const topLevel = yield* runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const commonGitDir = yield* runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return path.dirname(path.resolve(topLevel, commonGitDir));
});

export const listLocalTags = Effect.fn("lastcode.listLocalTags")(function* (repoRoot: string) {
  return (yield* runGit(repoRoot, ["tag", "--list"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
});

export const resolveLatestLocalNightlyTag = Effect.fn("lastcode.resolveLatestLocalNightlyTag")(
  function* (repoRoot: string) {
    const tag = resolveLatestNightlyTag(yield* listLocalTags(repoRoot));
    if (!tag) {
      return yield* new LastCodeNightlyError({
        message: "No upstream nightly tags are available locally.",
      });
    }
    return tag;
  },
);
