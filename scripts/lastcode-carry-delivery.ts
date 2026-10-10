// @effect-diagnostics nodeBuiltinImport:off -- Guarded merge intentionally invokes host Git processes.
import * as NodeChildProcess from "node:child_process";

import {
  CARRY_REPLAY_GROUPS,
  parseCarryTrailers,
  type CarryReplayGroup,
} from "./lastcode-carry-replay.ts";

export interface CarryReplayManifest {
  readonly replay?: { readonly mode?: string };
}

export interface CarrySourceDelivery {
  readonly base: string;
  readonly head: string;
  readonly ref: string;
}

export function shouldRetainCarrySources(manifest: CarryReplayManifest): boolean {
  return manifest.replay?.mode === "carry";
}

export function carrySourceRef(pullRequestNumber: number, head: string): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0)
    throw new Error("Carry source retention requires a valid pull request number.");
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error("Carry source retention requires an exact 40-character source head.");
  return `refs/lastcode/carry-sources/pr-${pullRequestNumber}/${head}`;
}

function git(repoRoot: string, args: ReadonlyArray<string>, allowFailure = false): string {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function gitSucceeds(repoRoot: string, args: ReadonlyArray<string>): boolean {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function carryGroup(commit: string, message: string): CarryReplayGroup {
  let trailers;
  try {
    trailers = parseCarryTrailers(message);
  } catch (error) {
    throw new Error(
      `Commit ${commit} has invalid Carry-Group metadata: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!trailers.group) {
    throw new Error(
      `Commit ${commit} must have exactly one Carry-Group trailer (${CARRY_REPLAY_GROUPS.join(", ")}). Prepare the reviewed source commits before merging.`,
    );
  }
  return trailers.group;
}

export function validateCarrySourceRange(
  repoRoot: string,
  pullRequestNumber: number,
  base: string,
  head: string,
): CarrySourceDelivery {
  if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head))
    throw new Error("Carry source retention requires exact reviewed base and head commits.");
  if (!gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", base, head]))
    throw new Error("Carry source base is not an ancestor of the reviewed head.");
  const commits = git(repoRoot, ["rev-list", "--reverse", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  if (commits.length === 0)
    throw new Error("Carry source retention requires at least one reviewed source commit.");
  for (const commit of commits) {
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/u);
    if (parents.length !== 2)
      throw new Error(
        `Commit ${commit} is not single-parent; prepare a linear reviewed source range.`,
      );
    carryGroup(commit, git(repoRoot, ["show", "-s", "--format=%B", commit]));
  }
  return { base, head, ref: carrySourceRef(pullRequestNumber, head) };
}

export function preserveCarrySource(repoRoot: string, source: CarrySourceDelivery): void {
  const existing = git(repoRoot, ["rev-parse", "--verify", "-q", source.ref], true);
  if (existing && existing !== source.head)
    throw new Error(
      `Carry source ref ${source.ref} already names ${existing}, not reviewed head ${source.head}.`,
    );
  if (!existing) git(repoRoot, ["update-ref", source.ref, source.head, ""]);
  const remote = git(repoRoot, ["ls-remote", "--refs", "origin", source.ref]);
  const remoteHead = remote === "" ? undefined : remote.split(/\s+/u)[0];
  if (remoteHead !== undefined && remoteHead !== source.head) {
    throw new Error(
      `Remote carry source ref ${source.ref} already names ${remoteHead}, not reviewed head ${source.head}.`,
    );
  }
  if (remoteHead === undefined) {
    git(repoRoot, [
      "push",
      "--force-with-lease=" + source.ref + ":0000000000000000000000000000000000000000",
      "origin",
      `${source.ref}:${source.ref}`,
    ]);
  }
}

export function assertNoReservedCarrySourceTrailers(body: string): void {
  if (/(?:^|\n)Carry-Source-(?:Ref|Base|Head):/mu.test(body)) {
    throw new Error(
      "Pull request body must not set Carry-Source-Ref, Carry-Source-Base, or Carry-Source-Head; guarded merge writes those from the reviewed commits.",
    );
  }
}

export function carrySquashBody(body: string, source: CarrySourceDelivery): string {
  assertNoReservedCarrySourceTrailers(body);
  return `${body.trimEnd()}${body.trim() ? "\n\n" : ""}Carry-Source-Ref: ${source.ref}\nCarry-Source-Base: ${source.base}\nCarry-Source-Head: ${source.head}\n`;
}
