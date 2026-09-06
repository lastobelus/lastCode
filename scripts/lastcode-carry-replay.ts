#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { cleanGitEnvironment } from "./lastcode-nightly.ts";

export const CARRY_REPLAY_GROUPS = [
  "upstream-bugfixes",
  "tooling",
  "build-ci",
  "resumable-actions",
  "legacy-sidebar",
  "incubator",
] as const;

export type CarryReplayGroup = (typeof CARRY_REPLAY_GROUPS)[number];

const CARRY_PLAN_FILE = "lastcode-carry-replay-plan.json";
const PUBLIC_METADATA_TRAILERS = [
  "Carry-Fix",
  "Carry-Upstream",
  "Carry-Observation",
  "Carry-Evidence",
  "Carry-Applies-To",
  "Carry-Supersedes",
] as const;

type PublicMetadataTrailer = (typeof PUBLIC_METADATA_TRAILERS)[number];

export interface CarryTrailers {
  readonly group?: CarryReplayGroup;
  readonly sourceRef?: string;
  readonly sourceBase?: string;
  readonly sourceHead?: string;
  readonly contributions: ReadonlyArray<CarryContributionMetadata>;
  readonly publicMetadata: Readonly<Record<PublicMetadataTrailer, ReadonlyArray<string>>>;
}

export interface CarryContributionMetadata {
  readonly sourceCommit: string;
  readonly subject: string;
  readonly group: CarryReplayGroup;
  readonly metadata: Readonly<Record<PublicMetadataTrailer, ReadonlyArray<string>>>;
}

export interface CarryGroupResult {
  readonly group: CarryReplayGroup;
  readonly commit: string;
  readonly contributions: ReadonlyArray<CarryContributionMetadata>;
}

export interface CarryReplayResult {
  readonly phase: CarryReplayPhase;
  readonly source: string;
  readonly sourceBase: string;
  readonly onto: string;
  readonly head: string;
  readonly groups?: ReadonlyArray<CarryGroupResult>;
}

export type CarryReplayPhase = "compile" | "replay" | "historical";

export interface CarryReplayPlan {
  readonly schemaVersion: 1;
  readonly phase: CarryReplayPhase;
  readonly status: "running" | "complete";
  readonly source: string;
  readonly sourceBase: string;
  readonly onto: string;
  readonly expectedSourceTree?: string;
  readonly resultHead?: string;
}

export interface CompileCarrySetInput {
  readonly repo: string;
  readonly worktree: string;
  readonly base: string;
  readonly source: string;
  readonly previousCompactHead?: string;
  readonly representedSource?: string;
  readonly preparedPartition?: CarryPreparedPartition;
}

export interface CarryPreparedPartition {
  readonly base: string;
  readonly source: string;
  readonly head: string;
}

export interface ReplayCarrySetInput {
  readonly repo: string;
  readonly worktree: string;
  readonly sourceBase: string;
  readonly compactHead: string;
  readonly onto: string;
}

export interface ReplayUngroupedInput {
  readonly repo: string;
  readonly worktree: string;
  readonly sourceBase: string;
  readonly currentSource: string;
  readonly onto: string;
  readonly representedCompactHead?: string;
  readonly representedSource?: string;
}

interface GitOptions {
  readonly allowFailure?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

interface ReplayItem {
  readonly commit: string;
  readonly group: CarryReplayGroup;
}

interface ExpandedCarrySource {
  readonly items: ReadonlyArray<ReplayItem>;
  readonly contributions: Readonly<
    Record<CarryReplayGroup, ReadonlyArray<CarryContributionMetadata>>
  >;
}

function runGit(cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: options.environment ?? cleanGitEnvironment(process.env),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function resolveCommit(repo: string, ref: string): string {
  return runGit(repo, ["rev-parse", `${ref}^{commit}`]);
}

function resolveTree(repo: string, ref: string): string {
  return runGit(repo, ["rev-parse", `${ref}^{tree}`]);
}

function lines(value: string): ReadonlyArray<string> {
  return value === "" ? [] : value.split(/\r?\n/u).filter(Boolean);
}

function emptyPublicMetadata(): Record<PublicMetadataTrailer, ReadonlyArray<string>> {
  return {
    "Carry-Fix": [],
    "Carry-Upstream": [],
    "Carry-Observation": [],
    "Carry-Evidence": [],
    "Carry-Applies-To": [],
    "Carry-Supersedes": [],
  };
}

function isCarryReplayGroup(value: string): value is CarryReplayGroup {
  return CARRY_REPLAY_GROUPS.some((group) => group === value);
}

function trailerValues(message: string, name: string): ReadonlyArray<string> {
  const prefix = `${name}:`;
  return message
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

export function parseCarryTrailers(message: string): CarryTrailers {
  const groups = trailerValues(message, "Carry-Group");
  if (groups.length > 1) throw new Error("A carry source commit must name exactly one group.");
  if (groups[0] !== undefined && !isCarryReplayGroup(groups[0])) {
    throw new Error(`Unknown carry group '${groups[0]}'.`);
  }

  const single = (name: string): string | undefined => {
    const values = trailerValues(message, name);
    if (values.length > 1) throw new Error(`${name} must appear at most once.`);
    return values[0];
  };
  const contributions = trailerValues(message, "Carry-Contribution").map((value) => {
    const parsed = JSON.parse(value) as CarryContributionMetadata;
    if (!parsed || !isCarryReplayGroup(parsed.group) || typeof parsed.sourceCommit !== "string") {
      throw new Error("Invalid Carry-Contribution metadata.");
    }
    return parsed;
  });
  const publicMetadata = emptyPublicMetadata();
  for (const name of PUBLIC_METADATA_TRAILERS) publicMetadata[name] = trailerValues(message, name);
  const group = groups[0];
  const sourceRef = single("Carry-Source-Ref");
  const sourceBase = single("Carry-Source-Base");
  const sourceHead = single("Carry-Source-Head");
  return {
    ...(group === undefined ? {} : { group }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(sourceBase === undefined ? {} : { sourceBase }),
    ...(sourceHead === undefined ? {} : { sourceHead }),
    contributions,
    publicMetadata,
  };
}

function commitMessage(repo: string, commit: string): string {
  return runGit(repo, ["show", "-s", "--format=%B", commit]);
}

function commitSubject(repo: string, commit: string): string {
  return runGit(repo, ["show", "-s", "--format=%s", commit]);
}

function commitParents(repo: string, commit: string): ReadonlyArray<string> {
  const value = runGit(repo, ["show", "-s", "--format=%P", commit]);
  return value === "" ? [] : value.split(/\s+/u);
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    runGit(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function firstParentCommits(repo: string, base: string, head: string): ReadonlyArray<string> {
  runGit(repo, ["merge-base", "--is-ancestor", base, head]);
  return lines(runGit(repo, ["rev-list", "--reverse", "--first-parent", `${base}..${head}`]));
}

function assertLinearRange(repo: string, base: string, commits: ReadonlyArray<string>): void {
  let parent = base;
  for (const commit of commits) {
    const parents = commitParents(repo, commit);
    if (parents.length !== 1 || parents[0] !== parent) {
      throw new Error(`Carry source commit ${commit} is not a linear child of ${parent}.`);
    }
    parent = commit;
  }
}

function contributionFromCommit(
  repo: string,
  commit: string,
  trailers: CarryTrailers,
): CarryContributionMetadata {
  if (!trailers.group) throw new Error(`Carry source commit ${commit} is missing Carry-Group.`);
  return {
    sourceCommit: commit,
    subject: commitSubject(repo, commit),
    group: trailers.group,
    metadata: trailers.publicMetadata,
  };
}

export function readCarryGroupChain(
  repo: string,
  headRef: string,
  baseRef: string,
): ReadonlyArray<CarryGroupResult> {
  const base = resolveCommit(repo, baseRef);
  const head = resolveCommit(repo, headRef);
  const commits = firstParentCommits(repo, base, head);
  assertLinearRange(repo, base, commits);
  if (commits.length !== CARRY_REPLAY_GROUPS.length) {
    throw new Error(
      `Compact carry chain must contain exactly ${CARRY_REPLAY_GROUPS.length} commits, found ${commits.length}.`,
    );
  }
  return commits.map((commit, index) => {
    const expected = CARRY_REPLAY_GROUPS[index];
    if (!expected) throw new Error(`Compact carry commit ${commit} has no ordered group.`);
    const trailers = parseCarryTrailers(commitMessage(repo, commit));
    if (trailers.group !== expected) {
      throw new Error(
        `Compact carry commit ${commit} names '${trailers.group ?? "no group"}', expected '${expected}'.`,
      );
    }
    const misplaced = trailers.contributions.find(
      (contribution) => contribution.group !== expected,
    );
    if (misplaced) {
      throw new Error(
        `Compact carry commit ${commit} contains ${misplaced.group} metadata inside ${expected}.`,
      );
    }
    return { group: expected, commit, contributions: trailers.contributions };
  });
}

function verifyPartitionRange(
  repo: string,
  baseRef: string,
  headRef: string,
): ReadonlyArray<{ readonly commit: string; readonly metadata: CarryContributionMetadata }> {
  const base = resolveCommit(repo, baseRef);
  const head = resolveCommit(repo, headRef);
  const commits = firstParentCommits(repo, base, head);
  assertLinearRange(repo, base, commits);
  return commits.map((commit) => {
    const trailers = parseCarryTrailers(commitMessage(repo, commit));
    return { commit, metadata: contributionFromCommit(repo, commit, trailers) };
  });
}

function binaryDiff(repo: string, base: string, head: string): string {
  return runGit(repo, ["diff", "--binary", "--full-index", base, head]);
}

function expandSquashCommit(
  repo: string,
  squashCommit: string,
): ReadonlyArray<{ readonly commit: string; readonly metadata: CarryContributionMetadata }> {
  const trailers = parseCarryTrailers(commitMessage(repo, squashCommit));
  if (!trailers.sourceRef || !trailers.sourceBase || !trailers.sourceHead) {
    throw new Error(
      `Squash commit ${squashCommit} must provide Carry-Source-Ref, Carry-Source-Base, and Carry-Source-Head.`,
    );
  }
  const squashParents = commitParents(repo, squashCommit);
  if (squashParents.length !== 1)
    throw new Error(`Squash commit ${squashCommit} is not single-parent.`);
  const sourceBase = resolveCommit(repo, trailers.sourceBase);
  const sourceHead = resolveCommit(repo, trailers.sourceHead);
  const sourceRef = resolveCommit(repo, trailers.sourceRef);
  if (sourceRef !== sourceHead) {
    throw new Error(`Carry source ref ${trailers.sourceRef} does not resolve to ${sourceHead}.`);
  }
  if (sourceBase !== squashParents[0]) {
    throw new Error(
      `Carry source base ${sourceBase} does not equal squash parent ${squashParents[0]}.`,
    );
  }
  if (resolveTree(repo, sourceBase) !== resolveTree(repo, squashParents[0])) {
    throw new Error(
      `Carry source base tree does not equal squash parent tree for ${squashCommit}.`,
    );
  }
  if (resolveTree(repo, sourceHead) !== resolveTree(repo, squashCommit)) {
    throw new Error(`Carry source head tree does not equal squash tree for ${squashCommit}.`);
  }
  if (
    binaryDiff(repo, sourceBase, sourceHead) !== binaryDiff(repo, squashParents[0], squashCommit)
  ) {
    throw new Error(`Carry source diff does not equal squash delta for ${squashCommit}.`);
  }
  return verifyPartitionRange(repo, sourceBase, sourceHead);
}

export function expandCarrySource(input: {
  readonly repo: string;
  readonly base: string;
  readonly source: string;
  readonly previousCompactHead?: string;
  readonly representedSource?: string;
  readonly preparedPartition?: CarryPreparedPartition;
}): ExpandedCarrySource {
  const grouped = new Map(
    CARRY_REPLAY_GROUPS.map((group) => [group, [] as CarryContributionMetadata[]]),
  );
  const items: ReplayItem[] = [];
  const add = (commit: string, metadata: CarryContributionMetadata) => {
    items.push({ commit, group: metadata.group });
    grouped.get(metadata.group)?.push(metadata);
  };

  if (input.preparedPartition) {
    if (input.previousCompactHead) {
      throw new Error(
        "Prepared bootstrap partition and previous compact head are mutually exclusive.",
      );
    }
    const preparedBase = resolveCommit(input.repo, input.preparedPartition.base);
    const preparedSource = resolveCommit(input.repo, input.preparedPartition.source);
    const preparedHead = resolveCommit(input.repo, input.preparedPartition.head);
    if (preparedBase !== resolveCommit(input.repo, input.base)) {
      throw new Error(
        "Prepared bootstrap partition base does not equal the configured upstream base.",
      );
    }
    const partition = verifyPartitionRange(input.repo, preparedBase, preparedHead);
    if (resolveTree(input.repo, preparedHead) !== resolveTree(input.repo, preparedSource)) {
      throw new Error(
        "Prepared bootstrap partition tree does not equal its frozen historical source tree.",
      );
    }
    const currentSource = resolveCommit(input.repo, input.source);
    if (!isAncestor(input.repo, preparedSource, currentSource)) {
      throw new Error("Current source does not descend from the prepared bootstrap source.");
    }
    for (const entry of partition) add(entry.commit, entry.metadata);
    const tail = firstParentCommits(input.repo, preparedSource, currentSource);
    assertLinearRange(input.repo, preparedSource, tail);
    for (const squashCommit of tail) {
      for (const entry of expandSquashCommit(input.repo, squashCommit))
        add(entry.commit, entry.metadata);
    }
  } else {
    if (!input.previousCompactHead) {
      throw new Error(
        "Same-base compilation requires a prepared bootstrap partition or previous compact head.",
      );
    }
    const compact = readCarryGroupChain(input.repo, input.previousCompactHead, input.base);
    for (const group of compact) {
      items.push({ commit: group.commit, group: group.group });
      for (const contribution of group.contributions) grouped.get(group.group)?.push(contribution);
    }
    const previousHead = resolveCommit(input.repo, input.previousCompactHead);
    const source = resolveCommit(input.repo, input.source);
    const tailBase = isAncestor(input.repo, previousHead, source)
      ? previousHead
      : input.representedSource
        ? resolveCommit(input.repo, input.representedSource)
        : undefined;
    if (!tailBase || !isAncestor(input.repo, tailBase, source)) {
      throw new Error(
        "Current source must descend from the compact head or its exact represented source.",
      );
    }
    const tail = firstParentCommits(input.repo, tailBase, source);
    assertLinearRange(input.repo, tailBase, tail);
    for (const squashCommit of tail) {
      for (const entry of expandSquashCommit(input.repo, squashCommit))
        add(entry.commit, entry.metadata);
    }
  }

  return {
    items,
    contributions: Object.fromEntries(
      CARRY_REPLAY_GROUPS.map((group) => [group, grouped.get(group) ?? []]),
    ) as unknown as Readonly<Record<CarryReplayGroup, ReadonlyArray<CarryContributionMetadata>>>,
  };
}

function carryPlanPath(worktree: string): string {
  const gitDirectory = runGit(worktree, ["rev-parse", "--absolute-git-dir"]);
  return NodePath.join(gitDirectory, CARRY_PLAN_FILE);
}

function writeCarryReplayPlan(worktree: string, plan: CarryReplayPlan): void {
  NodeFS.writeFileSync(carryPlanPath(worktree), `${JSON.stringify(plan, undefined, 2)}\n`, {
    mode: 0o600,
  });
}

export function readCarryReplayPlan(worktree: string): CarryReplayPlan | undefined {
  const path = carryPlanPath(worktree);
  if (!NodeFS.existsSync(path)) return undefined;
  const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as CarryReplayPlan;
  if (parsed.schemaVersion !== 1) throw new Error("Unsupported carry replay plan schema.");
  return parsed;
}

function assertWorktreeHead(worktree: string, expected: string): void {
  const actual = resolveCommit(worktree, "HEAD");
  if (actual !== expected)
    throw new Error(`Carry replay worktree is at ${actual}, expected ${expected}.`);
  if (runGit(worktree, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Carry replay worktree must be clean before replay starts.");
  }
}

function createAnchor(
  repo: string,
  base: string,
  group: CarryReplayGroup,
  message: string,
): string {
  const environment = {
    ...cleanGitEnvironment(process.env),
    GIT_AUTHOR_NAME: "LastCode carry replay",
    GIT_AUTHOR_EMAIL: "carry-replay@localhost",
    GIT_COMMITTER_NAME: "LastCode carry replay",
    GIT_COMMITTER_EMAIL: "carry-replay@localhost",
  };
  return runGit(repo, ["commit-tree", resolveTree(repo, base), "-p", base, "-m", message], {
    environment,
  });
}

function groupMessage(
  group: CarryReplayGroup,
  contributions: ReadonlyArray<CarryContributionMetadata>,
): string {
  return [
    `carry(${group}): compile downstream group`,
    "",
    `Carry-Group: ${group}`,
    ...contributions.map((contribution) => `Carry-Contribution: ${JSON.stringify(contribution)}`),
  ].join("\n");
}

function rebaseInProgress(worktree: string): boolean {
  const gitDirectory = runGit(worktree, ["rev-parse", "--absolute-git-dir"]);
  return ["rebase-merge", "rebase-apply"].some((name) =>
    NodeFS.existsSync(NodePath.join(gitDirectory, name)),
  );
}

function runInteractiveReplay(input: {
  readonly worktree: string;
  readonly currentHead: string;
  readonly upstream: string;
  readonly onto: string;
  readonly todo: ReadonlyArray<string>;
}): void {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-todo-"));
  const todoPath = NodePath.join(temporaryRoot, "todo");
  const editorPath = NodePath.join(temporaryRoot, "sequence-editor.sh");
  NodeFS.writeFileSync(todoPath, `${input.todo.join("\n")}\n`, { mode: 0o600 });
  NodeFS.writeFileSync(editorPath, '#!/bin/sh\ncp "$CARRY_REPLAY_TODO" "$1"\n', { mode: 0o700 });
  const environment = {
    ...cleanGitEnvironment(process.env),
    CARRY_REPLAY_TODO: todoPath,
    GIT_SEQUENCE_EDITOR: editorPath,
    GIT_EDITOR: "true",
  };
  try {
    runGit(
      input.worktree,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "rebase",
        "--interactive",
        "--onto",
        input.onto,
        input.upstream,
        input.currentHead,
        "--keep-empty",
        "--empty=keep",
        "--reapply-cherry-picks",
      ],
      { environment },
    );
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function startPlan(
  worktree: string,
  plan: Omit<CarryReplayPlan, "schemaVersion" | "status">,
): void {
  writeCarryReplayPlan(worktree, { schemaVersion: 1, status: "running", ...plan });
}

function finishPlan(worktree: string, plan: CarryReplayPlan, resultHead: string): void {
  writeCarryReplayPlan(worktree, { ...plan, status: "complete", resultHead });
}

export function completeCarryReplay(worktree: string): CarryReplayResult {
  const plan = readCarryReplayPlan(worktree);
  if (!plan) throw new Error("Carry replay worktree has no persisted plan.");
  if (rebaseInProgress(worktree))
    throw new Error("Carry replay still has unresolved rebase state.");
  const head = resolveCommit(worktree, "HEAD");
  if (plan.status === "complete" && plan.resultHead !== head) {
    throw new Error(
      `Completed carry replay recorded ${plan.resultHead ?? "no head"}, found ${head}.`,
    );
  }
  let groups: ReadonlyArray<CarryGroupResult> | undefined;
  if (plan.phase !== "historical") groups = readCarryGroupChain(worktree, head, plan.onto);
  if (
    plan.phase === "compile" &&
    plan.expectedSourceTree !== undefined &&
    resolveTree(worktree, head) !== plan.expectedSourceTree
  ) {
    throw new Error("Compiled carry tree does not equal the expected source tree.");
  }
  if (plan.status !== "complete") finishPlan(worktree, plan, head);
  return {
    phase: plan.phase,
    source: plan.source,
    sourceBase: plan.sourceBase,
    onto: plan.onto,
    head,
    ...(groups ? { groups } : {}),
  };
}

export function compileCarrySetSameBase(input: CompileCarrySetInput): CarryReplayResult {
  const base = resolveCommit(input.repo, input.base);
  const source = resolveCommit(input.repo, input.source);
  const replayHead = resolveCommit(input.repo, input.source);
  assertWorktreeHead(input.worktree, replayHead);
  const expanded = expandCarrySource({
    repo: input.repo,
    base,
    source,
    ...(input.previousCompactHead ? { previousCompactHead: input.previousCompactHead } : {}),
    ...(input.representedSource ? { representedSource: input.representedSource } : {}),
    ...(input.preparedPartition ? { preparedPartition: input.preparedPartition } : {}),
  });
  const anchors = new Map(
    CARRY_REPLAY_GROUPS.map((group) => [
      group,
      createAnchor(input.repo, base, group, groupMessage(group, expanded.contributions[group])),
    ]),
  );
  const todo: string[] = [];
  for (const group of CARRY_REPLAY_GROUPS) {
    todo.push(`pick ${anchors.get(group)} carry(${group}): compile downstream group`);
    for (const item of expanded.items.filter((candidate) => candidate.group === group)) {
      todo.push(`fixup ${item.commit} ${commitSubject(input.repo, item.commit)}`);
    }
  }
  const previousCompactHead = input.previousCompactHead
    ? resolveCommit(input.repo, input.previousCompactHead)
    : undefined;
  const representedSource = input.representedSource
    ? resolveCommit(input.repo, input.representedSource)
    : undefined;
  const sameBaseCompilation =
    input.preparedPartition !== undefined ||
    (previousCompactHead !== undefined && isAncestor(input.repo, previousCompactHead, source));
  startPlan(input.worktree, {
    phase: "compile",
    source,
    sourceBase: base,
    onto: base,
    ...(sameBaseCompilation ? { expectedSourceTree: resolveTree(input.repo, source) } : {}),
  });
  runInteractiveReplay({
    worktree: input.worktree,
    currentHead: replayHead,
    upstream: input.preparedPartition ? base : (representedSource ?? base),
    onto: base,
    todo,
  });
  return completeCarryReplay(input.worktree);
}

export function replayCarrySetOnto(input: ReplayCarrySetInput): CarryReplayResult {
  const sourceBase = resolveCommit(input.repo, input.sourceBase);
  const compactHead = resolveCommit(input.repo, input.compactHead);
  const onto = resolveCommit(input.repo, input.onto);
  assertWorktreeHead(input.worktree, compactHead);
  const groups = readCarryGroupChain(input.repo, compactHead, sourceBase);
  startPlan(input.worktree, {
    phase: "replay",
    source: compactHead,
    sourceBase,
    onto,
  });
  runInteractiveReplay({
    worktree: input.worktree,
    currentHead: compactHead,
    upstream: sourceBase,
    onto,
    todo: groups.map(({ commit, group }) => `pick ${commit} carry(${group})`),
  });
  return completeCarryReplay(input.worktree);
}

export function replayUngroupedOnto(input: ReplayUngroupedInput): CarryReplayResult {
  const sourceBase = resolveCommit(input.repo, input.sourceBase);
  const currentSource = resolveCommit(input.repo, input.currentSource);
  const onto = resolveCommit(input.repo, input.onto);
  assertWorktreeHead(input.worktree, currentSource);
  const todo: string[] = [];
  if (input.representedCompactHead) {
    if (!input.representedSource) {
      throw new Error(
        "Historical replay from a compact generation requires its represented source.",
      );
    }
    const compactHead = resolveCommit(input.repo, input.representedCompactHead);
    const representedSource = resolveCommit(input.repo, input.representedSource);
    const groups = readCarryGroupChain(input.repo, compactHead, sourceBase);
    for (const group of groups) todo.push(`pick ${group.commit} carry(${group.group})`);
    const compactIsAncestor = isAncestor(input.repo, compactHead, currentSource);
    const tailBase = compactIsAncestor ? compactHead : representedSource;
    const tail = firstParentCommits(input.repo, tailBase, currentSource);
    assertLinearRange(input.repo, tailBase, tail);
    for (const commit of tail) todo.push(`pick ${commit} ${commitSubject(input.repo, commit)}`);
  } else {
    const commits = firstParentCommits(input.repo, sourceBase, currentSource);
    assertLinearRange(input.repo, sourceBase, commits);
    for (const commit of commits) todo.push(`pick ${commit} ${commitSubject(input.repo, commit)}`);
  }
  startPlan(input.worktree, {
    phase: "historical",
    source: currentSource,
    sourceBase,
    onto,
  });
  const upstream = input.representedCompactHead
    ? isAncestor(input.repo, resolveCommit(input.repo, input.representedCompactHead), currentSource)
      ? sourceBase
      : resolveCommit(input.repo, input.representedSource ?? "")
    : sourceBase;
  runInteractiveReplay({
    worktree: input.worktree,
    currentHead: currentSource,
    upstream,
    onto,
    todo,
  });
  return completeCarryReplay(input.worktree);
}
