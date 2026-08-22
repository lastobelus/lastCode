#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  LASTCODE_CHECKPOINT_TAG_PREFIX,
  LASTCODE_REVISION_TAG_PREFIX,
  nightlyTagFromCheckpointTag,
  parseLastCodeInstallableTag,
  parseNightlyTag,
  versionFromLastCodeInstallableTag,
  type LastCodeInstallableTag,
  type NightlyTag,
} from "./lib/lastcode-installable-tag.ts";

export {
  LASTCODE_CHECKPOINT_TAG_PREFIX,
  LASTCODE_REVISION_TAG_PREFIX,
  nightlyTagFromCheckpointTag,
  parseLastCodeInstallableTag,
  parseNightlyTag,
  versionFromLastCodeInstallableTag,
  versionFromNightlyTag,
  type LastCodeInstallableTag,
  type NightlyTag,
} from "./lib/lastcode-installable-tag.ts";

export const LASTCODE_BUILD_TAG_PREFIX = "lastcode/build/";

export class LastCodeNightlyError extends Data.TaggedError("LastCodeNightlyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const GIT_LOCAL_ENVIRONMENT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

export function cleanGitEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !GIT_LOCAL_ENVIRONMENT_VARIABLES.has(entry[0]),
    ),
  );
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

export function checkpointTagFromNightlyTag(tag: string): string {
  if (!parseNightlyTag(tag)) {
    throw new Error(`Invalid upstream nightly tag '${tag}'.`);
  }
  return `${LASTCODE_CHECKPOINT_TAG_PREFIX}${tag}`;
}

export function revisionTagFromNightlyTag(tag: string, revision: number): string {
  if (!parseNightlyTag(tag)) {
    throw new Error(`Invalid upstream nightly tag '${tag}'.`);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Invalid LastCode revision '${revision}'.`);
  }
  return `${LASTCODE_REVISION_TAG_PREFIX}${tag}.${revision}`;
}

export function compareLastCodeInstallableTags(
  left: LastCodeInstallableTag,
  right: LastCodeInstallableTag,
): number {
  const nightlyOrder = compareNightlyTags(left.nightly, right.nightly);
  return nightlyOrder === 0 ? left.revision - right.revision : nightlyOrder;
}

export function buildTagFromInstallableTag(installableTag: string, buildNumber: number): string {
  const installable = parseLastCodeInstallableTag(installableTag);
  if (!installable) {
    throw new Error(`Invalid LastCode installable tag '${installableTag}'.`);
  }
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Invalid LastCode build number '${buildNumber}'.`);
  }
  return `${LASTCODE_BUILD_TAG_PREFIX}v${versionFromLastCodeInstallableTag(installableTag)}.${buildNumber}`;
}

export function resolveUncheckpointedNightlies(
  nightlyTags: ReadonlyArray<string>,
  checkpointTags: ReadonlyArray<string>,
): ReadonlyArray<NightlyTag> {
  const checkpointed = new Set(
    checkpointTags
      .map((tag) => nightlyTagFromCheckpointTag(tag))
      .filter((tag): tag is string => tag !== undefined),
  );

  return nightlyTags
    .map((tag) => parseNightlyTag(tag))
    .filter((tag): tag is NightlyTag => tag !== undefined && !checkpointed.has(tag.tag))
    .toSorted(compareNightlyTags);
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
  const child = yield* spawner.spawn(
    ChildProcess.make("git", args, {
      cwd: repoRoot,
      env: cleanGitEnvironment(process.env),
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
  return yield* runGit(cwd, ["rev-parse", "--show-toplevel"]);
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
