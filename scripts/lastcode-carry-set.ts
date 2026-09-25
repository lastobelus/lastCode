#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { cleanGitEnvironment } from "./lastcode-nightly.ts";
import {
  CARRY_REPLAY_GROUPS,
  compileCarrySetSameBase,
  readCarryGroupChain,
} from "./lastcode-carry-replay.ts";
import { parseManifestReplayConfiguration } from "./lastcode-carry-checkpoint.ts";

export const CARRY_GROUPS = CARRY_REPLAY_GROUPS;

export type CarryGroup = (typeof CARRY_GROUPS)[number];

export interface CarryCommit {
  readonly commit: string;
  readonly subject: string;
  readonly pullRequest?: number;
}

interface GroupManifest {
  readonly default?: boolean;
  readonly pullRequests?: ReadonlyArray<number>;
  readonly subjects?: ReadonlyArray<string>;
  readonly upstreamPullRequests?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface CarrySetManifest {
  readonly schemaVersion: 1;
  readonly order: ReadonlyArray<CarryGroup>;
  readonly groups: Readonly<Record<CarryGroup, GroupManifest>>;
}

export interface CarryGroupPlan {
  readonly id: CarryGroup;
  readonly commits: ReadonlyArray<CarryCommit>;
}

export interface CarryPathTouch {
  readonly group: CarryGroup;
  readonly paths: ReadonlyArray<string>;
}

export interface CarrySetShadowTarget {
  readonly checkpointTag: string;
  readonly replayMode?: "carry" | "historical";
  readonly baseCommit: string;
  readonly sourceCommit: string;
}

export interface CarrySetShadowResult extends CarrySetShadowTarget {
  readonly groups: ReadonlyArray<CarryGroupPlan>;
  readonly tree: string;
}

interface Options {
  readonly base: string;
  readonly json: boolean;
  readonly manifestPath: string;
  readonly reconstruct: boolean;
  readonly source: string;
}

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const defaultManifestPath = NodePath.join(scriptDirectory, "lastcode-carry-set.json");

function run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean; readonly inherit?: boolean } = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanGitEnvironment(process.env),
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function git(repoRoot: string, args: ReadonlyArray<string>, cwd = repoRoot): string {
  return run(cwd, "git", args);
}

function splitLines(value: string): ReadonlyArray<string> {
  return value === "" ? [] : value.split("\n");
}

function splitNulls(value: string): ReadonlyArray<string> {
  return value === "" ? [] : value.split("\0").filter(Boolean);
}

export function pullRequestFromSubject(subject: string): number | undefined {
  const match = subject.match(/\(#(\d+)\)$/);
  return match ? Number(match[1]) : undefined;
}

export function parseCarryCommit(line: string): CarryCommit {
  const separator = line.indexOf("\t");
  if (separator === -1) throw new Error(`Invalid commit record: ${line}`);
  const commit = line.slice(0, separator);
  const subject = line.slice(separator + 1);
  const pullRequest = pullRequestFromSubject(subject);
  return { commit, subject, ...(pullRequest === undefined ? {} : { pullRequest }) };
}

export function validateManifest(manifest: CarrySetManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Carry-set manifest schemaVersion must be 1.");
  if (JSON.stringify(manifest.order) !== JSON.stringify(CARRY_GROUPS)) {
    throw new Error(`Carry-set order must be ${CARRY_GROUPS.join(" -> ")}.`);
  }

  const pullRequests = new Map<number, CarryGroup>();
  const subjects = new Map<string, CarryGroup>();
  const defaults = CARRY_GROUPS.filter((group) => manifest.groups[group]?.default);
  if (defaults.length !== 1 || defaults[0] !== "incubator") {
    throw new Error("Incubator must be the only default carry group.");
  }

  for (const group of CARRY_GROUPS) {
    const definition = manifest.groups[group];
    if (!definition) throw new Error(`Carry-set manifest is missing ${group}.`);
    for (const pullRequest of definition.pullRequests ?? []) {
      const previous = pullRequests.get(pullRequest);
      if (previous)
        throw new Error(`LastCode PR #${pullRequest} is assigned to ${previous} and ${group}.`);
      pullRequests.set(pullRequest, group);
      if (
        group === "upstream-bugfixes" &&
        (definition.upstreamPullRequests?.[String(pullRequest)]?.length ?? 0) === 0
      ) {
        throw new Error(
          `Upstream bugfix LastCode PR #${pullRequest} has no upstream PR provenance.`,
        );
      }
    }
    for (const subject of definition.subjects ?? []) {
      const previous = subjects.get(subject);
      if (previous)
        throw new Error(`Subject '${subject}' is assigned to ${previous} and ${group}.`);
      subjects.set(subject, group);
    }
  }
}

export function planCarrySet(
  commits: ReadonlyArray<CarryCommit>,
  manifest: CarrySetManifest,
): ReadonlyArray<CarryGroupPlan> {
  validateManifest(manifest);
  const pullRequests = new Map<number, CarryGroup>();
  const subjects = new Map<string, CarryGroup>();
  for (const group of CARRY_GROUPS) {
    for (const pullRequest of manifest.groups[group].pullRequests ?? []) {
      pullRequests.set(pullRequest, group);
    }
    for (const subject of manifest.groups[group].subjects ?? []) subjects.set(subject, group);
  }

  const grouped = new Map(CARRY_GROUPS.map((group) => [group, [] as CarryCommit[]]));
  for (const commit of commits) {
    const group =
      (commit.pullRequest === undefined ? undefined : pullRequests.get(commit.pullRequest)) ??
      subjects.get(commit.subject) ??
      "incubator";
    grouped.get(group)?.push(commit);
  }
  return CARRY_GROUPS.map((id) => ({ id, commits: grouped.get(id) ?? [] }));
}

export function attributeCarryPaths(
  changedPaths: ReadonlyArray<string>,
  touches: ReadonlyArray<CarryPathTouch>,
): Readonly<Record<CarryGroup, ReadonlyArray<string>>> {
  const changed = new Set(changedPaths);
  const touchedBy = new Map<string, Set<CarryGroup>>();
  for (const touch of touches) {
    for (const path of touch.paths) {
      if (!changed.has(path)) continue;
      const groups = touchedBy.get(path) ?? new Set<CarryGroup>();
      groups.add(touch.group);
      touchedBy.set(path, groups);
    }
  }

  const grouped = new Map(CARRY_GROUPS.map((group) => [group, [] as string[]]));
  for (const path of changedPaths) {
    const groups = [...(touchedBy.get(path) ?? [])];
    const owner = groups.length === 1 && groups[0] ? groups[0] : "incubator";
    grouped.get(owner)?.push(path);
  }
  return {
    "upstream-bugfixes": grouped.get("upstream-bugfixes") ?? [],
    tooling: grouped.get("tooling") ?? [],
    "build-ci": grouped.get("build-ci") ?? [],
    "resumable-actions": grouped.get("resumable-actions") ?? [],
    "legacy-sidebar": grouped.get("legacy-sidebar") ?? [],
    incubator: grouped.get("incubator") ?? [],
  };
}

function parseOptions(args: ReadonlyArray<string>): Options {
  let base: string | undefined;
  let manifestPath = defaultManifestPath;
  let source = "HEAD";
  let json = false;
  let reconstruct = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--base") base = args[++index];
    else if (argument === "--source") source = args[++index] ?? source;
    else if (argument === "--manifest") manifestPath = args[++index] ?? manifestPath;
    else if (argument === "--json") json = true;
    else if (argument === "--reconstruct") reconstruct = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!base) {
    throw new Error(
      "Usage: pnpm lastcode:carry-set -- --base <upstream-ref> [--source <ref>] [--reconstruct] [--json]",
    );
  }
  return { base, json, manifestPath, reconstruct, source };
}

function readManifest(manifestPath: string): CarrySetManifest {
  return JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as CarrySetManifest;
}

export function carrySetShadowTarget(
  checkpointTag: string,
  tagContents: string,
  taggedCommit: string,
): CarrySetShadowTarget {
  const trailers = new Map<string, string>();
  for (const line of tagContents.split(/\r?\n/u)) {
    const separator = line.indexOf(": ");
    if (separator > 0) trailers.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const baseCommit = trailers.get("Upstream-Commit");
  const sourceCommit = trailers.get("LastCode-Commit");
  if (!baseCommit || !sourceCommit) {
    throw new Error(`${checkpointTag} is missing immutable carry-set metadata.`);
  }
  if (sourceCommit !== taggedCommit) {
    throw new Error(
      `${checkpointTag} metadata names ${sourceCommit}, but the tag resolves to ${taggedCommit}.`,
    );
  }
  const replayMode = trailers.get("Replay-Mode");
  if (replayMode !== undefined && replayMode !== "carry" && replayMode !== "historical") {
    throw new Error(`${checkpointTag} has an invalid Replay-Mode.`);
  }
  return {
    checkpointTag,
    baseCommit,
    sourceCommit,
    ...(replayMode ? { replayMode } : {}),
  };
}

function readCommits(repoRoot: string, base: string, source: string): ReadonlyArray<CarryCommit> {
  run(repoRoot, "git", ["merge-base", "--is-ancestor", base, source]);
  const records = splitLines(
    git(repoRoot, ["log", "--reverse", "--format=%H%x09%s", `${base}..${source}`]),
  );
  const commits = records.map(parseCarryCommit);
  for (const commit of commits) {
    const parents = git(repoRoot, ["show", "-s", "--format=%P", commit.commit]).split(" ");
    if (parents.length !== 1)
      throw new Error(`Carry commit ${commit.commit} is not a single-parent commit.`);
  }
  return commits;
}

function reconstruct(
  repoRoot: string,
  base: string,
  source: string,
  plan: ReadonlyArray<CarryGroupPlan>,
): {
  readonly commits: Readonly<Record<CarryGroup, string>>;
  readonly paths: Readonly<Record<CarryGroup, ReadonlyArray<string>>>;
  readonly tree: string;
} {
  // Reconstruction needs both sides of a rename: the destination is copied from the source tree,
  // and the source path must be removed from the base tree.
  const changedPaths = splitNulls(
    git(repoRoot, ["diff", "--no-renames", "--name-only", "-z", base, source]),
  );
  const paths = attributeCarryPaths(
    changedPaths,
    plan.flatMap((group) =>
      group.commits.map((commit) => ({
        group: group.id,
        paths: splitNulls(
          git(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit.commit]),
        ),
      })),
    ),
  );
  const sourcePaths = new Set(
    splitNulls(git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", source])),
  );
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-set-"));
  const worktree = NodePath.join(temporaryRoot, "worktree");
  const groupCommits = {} as Record<CarryGroup, string>;
  let worktreeAdded = false;
  try {
    run(repoRoot, "git", ["worktree", "add", "--detach", worktree, base]);
    worktreeAdded = true;
    for (const group of plan) {
      const existing = paths[group.id].filter((path) => sourcePaths.has(path));
      const existingSet = new Set(existing);
      const deleted = paths[group.id].filter((path) => !existingSet.has(path));
      if (existing.length > 0) run(worktree, "git", ["checkout", source, "--", ...existing]);
      if (deleted.length > 0) {
        run(worktree, "git", ["rm", "--force", "--ignore-unmatch", "--", ...deleted]);
      }
      run(worktree, "git", [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=LastCode carry-set proof",
        "-c",
        "user.email=carry-set@localhost",
        "commit",
        "--allow-empty",
        "-m",
        `carry(${group.id}): reconstruct checkpoint group`,
      ]);
      groupCommits[group.id] = git(worktree, ["rev-parse", "HEAD"]);
    }

    const tree = git(worktree, ["rev-parse", "HEAD^{tree}"]);
    const sourceTree = git(repoRoot, ["rev-parse", `${source}^{tree}`]);
    if (tree !== sourceTree) {
      throw new Error(`Reconstructed tree ${tree} does not match source tree ${sourceTree}.`);
    }
    return { commits: groupCommits, paths, tree };
  } finally {
    if (worktreeAdded) {
      run(repoRoot, "git", ["worktree", "remove", "--force", worktree], { allowFailure: true });
    }
    if (temporaryRoot.startsWith(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-set-"))) {
      NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export function runCarrySetShadowCheck(
  repoRoot: string,
  checkpointTag: string,
  manifestPath = defaultManifestPath,
): CarrySetShadowResult {
  const target = carrySetShadowTarget(
    checkpointTag,
    git(repoRoot, ["for-each-ref", "--format=%(contents)", `refs/tags/${checkpointTag}`]),
    git(repoRoot, ["rev-list", "-n", "1", checkpointTag]),
  );
  const manifest = readManifest(manifestPath);
  if (target.replayMode === "carry") {
    const groups = readCarryGroupChain(repoRoot, target.sourceCommit, target.baseCommit);
    return {
      ...target,
      groups: groups.map(({ group, contributions }) => ({
        id: group,
        commits: contributions.map(({ sourceCommit, subject }) => ({
          commit: sourceCommit,
          subject,
        })),
      })),
      tree: git(repoRoot, ["rev-parse", `${target.sourceCommit}^{tree}`]),
    };
  }
  const plan = planCarrySet(
    readCommits(repoRoot, target.baseCommit, target.sourceCommit),
    manifest,
  );
  const proof = reconstruct(repoRoot, target.baseCommit, target.sourceCommit, plan);
  return { ...target, groups: plan, tree: proof.tree };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const base = git(repoRoot, ["rev-parse", `${options.base}^{commit}`]);
  const source = git(repoRoot, ["rev-parse", `${options.source}^{commit}`]);
  const manifest = readManifest(options.manifestPath);
  const replay = parseManifestReplayConfiguration(manifest);
  if (replay?.mode === "carry") {
    if (!options.reconstruct) {
      const groups = readCarryGroupChain(repoRoot, source, base);
      console.log(JSON.stringify({ base, source, groups }, undefined, 2));
      return;
    }
    const temporaryRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-carry-compile-"),
    );
    const worktree = NodePath.join(temporaryRoot, "worktree");
    run(repoRoot, "git", ["worktree", "add", "--detach", worktree, source]);
    try {
      const result = compileCarrySetSameBase({
        repo: repoRoot,
        worktree,
        base,
        source,
        preparedPartition: replay.bootstrap,
      });
      console.log(JSON.stringify(result, undefined, 2));
    } catch (error) {
      throw new Error(
        `Carry compilation retained at ${worktree}. Resolve and continue its recorded phase.`,
        { cause: error },
      );
    }
    run(repoRoot, "git", ["worktree", "remove", worktree]);
    NodeFS.rmSync(temporaryRoot, { recursive: true });
    return;
  }
  const plan = planCarrySet(readCommits(repoRoot, base, source), manifest);
  const proof = options.reconstruct ? reconstruct(repoRoot, base, source, plan) : undefined;
  const result = { base, source, groups: plan, ...(proof ? { proof } : {}) };

  if (options.json) {
    console.log(JSON.stringify(result, undefined, 2));
    return;
  }
  console.log(`Downstream carry set: ${base.slice(0, 12)}..${source.slice(0, 12)}`);
  for (const group of plan) {
    const pathSummary = proof ? `, ${proof.paths[group.id].length} final path(s)` : "";
    console.log(`${group.id}: ${group.commits.length} commit(s)${pathSummary}`);
  }
  if (proof) console.log(`Reconstruction passed: ${proof.tree}`);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main();
}
