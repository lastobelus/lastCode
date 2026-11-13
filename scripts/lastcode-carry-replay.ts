#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { cleanGitEnvironment } from "./lastcode-nightly.ts";
import {
  isCheckpointMessageRewrite,
  normalizeCheckpointCommits,
} from "./lastcode-quiet-references.ts";
import { writeCarryConflictDossier } from "./lastcode-carry-dossier.ts";

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
  readonly deletedPaths?: ReadonlyArray<string>;
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
  readonly partitionedTail?: boolean;
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
  readonly raw?: boolean;
  readonly allowFailure?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
}

interface ReplayItem {
  readonly commit: string;
  readonly group: CarryReplayGroup;
  readonly metadata?: CarryContributionMetadata;
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
    input: options.input,
    timeout: options.timeout ?? 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    throw new Error(
      [
        `git ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return options.raw ? result.stdout : result.stdout.trim();
}

function createCommit(
  repo: string,
  tree: string,
  parent: string,
  message: string,
  environment: NodeJS.ProcessEnv = cleanGitEnvironment(process.env),
): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-message-"));
  const path = NodePath.join(directory, "message");
  try {
    NodeFS.writeFileSync(path, message, { mode: 0o600 });
    return runGit(
      repo,
      ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", parent, "-F", path],
      {
        environment,
      },
    );
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
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

function mergeTree(repo: string, base: string, current: string, source: string): string {
  return runGit(repo, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    `--merge-base=${base}`,
    current,
    source,
  ]);
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
  const squashParent = squashParents[0];
  if (!squashParent) throw new Error(`Squash commit ${squashCommit} has no parent.`);
  if (sourceBase === squashParent) {
    if (resolveTree(repo, sourceBase) !== resolveTree(repo, squashParent)) {
      throw new Error(
        `Carry source base tree does not equal squash parent tree for ${squashCommit}.`,
      );
    }
    if (resolveTree(repo, sourceHead) !== resolveTree(repo, squashCommit)) {
      throw new Error(`Carry source head tree does not equal squash tree for ${squashCommit}.`);
    }
    if (binaryDiff(repo, sourceBase, sourceHead) !== binaryDiff(repo, squashParent, squashCommit)) {
      throw new Error(`Carry source diff does not equal squash delta for ${squashCommit}.`);
    }
  } else {
    if (!isAncestor(repo, sourceBase, squashParent)) {
      throw new Error(
        `Carry source base ${sourceBase} does not equal squash parent ${squashParent} or precede it.`,
      );
    }
    if (resolveTree(repo, squashCommit) !== mergeTree(repo, sourceBase, squashParent, sourceHead)) {
      throw new Error(
        `Carry source merged from ${sourceBase} does not equal squash tree for ${squashCommit}.`,
      );
    }
  }
  return verifyPartitionRange(repo, sourceBase, sourceHead);
}

function normalizeCarryDeletions(
  repo: string,
  items: ReadonlyArray<ReplayItem>,
  grouped: Map<CarryReplayGroup, CarryContributionMetadata[]>,
): ReadonlyArray<ReplayItem> {
  const owners = new Map<string, { readonly group: CarryReplayGroup; readonly commit: string }>();
  const normalized: ReplayItem[] = [];
  for (const item of items) {
    const parent = commitParents(repo, item.commit)[0];
    if (!parent) throw new Error(`Carry contribution ${item.commit} has no parent.`);
    const changes = runGit(repo, [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      parent,
      item.commit,
    ]).split("\0");
    const deletions = new Map<CarryReplayGroup, string[]>();
    for (let index = 0; index + 1 < changes.length; index += 2) {
      const status = changes[index];
      const path = changes[index + 1];
      if (!path) continue;
      const owner = owners.get(path);
      if (
        status === "D" &&
        item.metadata &&
        owner &&
        CARRY_REPLAY_GROUPS.indexOf(owner.group) > CARRY_REPLAY_GROUPS.indexOf(item.group)
      ) {
        deletions.set(owner.group, [...(deletions.get(owner.group) ?? []), path]);
      }
    }
    if (deletions.size === 0 || !item.metadata) {
      normalized.push(item);
    } else {
      const temporaryRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "lastcode-carry-index-"),
      );
      const environment = {
        ...cleanGitEnvironment(process.env),
        GIT_INDEX_FILE: NodePath.join(temporaryRoot, "index"),
      };
      const derive = (treeSource: string, args: ReadonlyArray<string>) => {
        runGit(repo, ["read-tree", treeSource], { environment });
        runGit(repo, args, { environment });
        const tree = runGit(repo, ["write-tree"], { environment });
        return tree === resolveTree(repo, parent)
          ? undefined
          : createCommit(repo, tree, parent, commitMessage(repo, item.commit));
      };
      try {
        // A deletion follows the carried introduction, so regrouping cannot re-add it.
        // These derived deltas retain the original source identity and never alter it.
        grouped.set(
          item.group,
          (grouped.get(item.group) ?? []).filter((entry) => entry !== item.metadata),
        );
        const remaining = derive(item.commit, [
          "restore",
          `--source=${parent}`,
          "--staged",
          "--",
          ...Array.from(deletions.values()).flat(),
        ]);
        if (remaining) {
          normalized.push({ ...item, commit: remaining });
          grouped.get(item.group)?.push(item.metadata);
        }
        for (const [group, paths] of deletions) {
          const commit = derive(parent, ["update-index", "--force-remove", "--", ...paths]);
          if (!commit) throw new Error(`Carry deletion partition for ${item.commit} is empty.`);
          const metadata: CarryContributionMetadata = {
            ...item.metadata,
            group,
            deletedPaths: paths,
            metadata: {
              ...item.metadata.metadata,
              "Carry-Observation": [
                ...item.metadata.metadata["Carry-Observation"],
                `Deletion partition follows the ${group} introduction of ${paths.join(", ")}.`,
              ],
              "Carry-Supersedes": [
                ...item.metadata.metadata["Carry-Supersedes"],
                ...paths.map((path) => {
                  const owner = owners.get(path);
                  if (!owner) throw new Error(`Carry deletion of ${path} has no introduction.`);
                  return `${owner.commit} (${path})`;
                }),
              ],
            },
          };
          normalized.push({ commit, group, metadata });
          grouped.get(group)?.push(metadata);
        }
      } finally {
        NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    }
    for (let index = 0; index + 1 < changes.length; index += 2) {
      const status = changes[index];
      const path = changes[index + 1];
      if (!path) continue;
      if (status === "A") owners.set(path, { group: item.group, commit: item.commit });
      else if (status === "D") owners.delete(path);
    }
  }
  return normalized;
}

export function expandCarrySource(input: {
  readonly repo: string;
  readonly base: string;
  readonly source: string;
  readonly previousCompactHead?: string;
  readonly representedSource?: string;
  readonly preparedPartition?: CarryPreparedPartition;
  readonly partitionedTail?: boolean;
}): ExpandedCarrySource {
  const grouped = new Map(
    CARRY_REPLAY_GROUPS.map((group) => [group, [] as CarryContributionMetadata[]]),
  );
  const items: ReplayItem[] = [];
  const add = (commit: string, metadata: CarryContributionMetadata) => {
    items.push({ commit, group: metadata.group, metadata });
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
    const preparedCommits = firstParentCommits(input.repo, preparedBase, preparedHead);
    assertLinearRange(input.repo, preparedBase, preparedCommits);
    const preparedCompact = preparedCommits.some(
      (commit) => parseCarryTrailers(commitMessage(input.repo, commit)).contributions.length > 0,
    )
      ? readCarryGroupChain(input.repo, preparedHead, preparedBase)
      : undefined;
    if (resolveTree(input.repo, preparedHead) !== resolveTree(input.repo, preparedSource)) {
      throw new Error(
        "Prepared bootstrap partition tree does not equal its frozen historical source tree.",
      );
    }
    const currentSource = resolveCommit(input.repo, input.source);
    const representedSource = input.representedSource
      ? resolveCommit(input.repo, input.representedSource)
      : preparedSource;
    if (!isAncestor(input.repo, representedSource, currentSource)) {
      throw new Error(
        "Current source does not descend from the prepared bootstrap source or its proven represented source.",
      );
    }
    if (preparedCompact) {
      for (const group of preparedCompact) {
        items.push({ commit: group.commit, group: group.group });
        for (const contribution of group.contributions)
          grouped.get(group.group)?.push(contribution);
      }
    } else {
      for (const entry of verifyPartitionRange(input.repo, preparedBase, preparedHead))
        add(entry.commit, entry.metadata);
    }
    const tail = firstParentCommits(input.repo, representedSource, currentSource);
    assertLinearRange(input.repo, representedSource, tail);
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
    if (input.partitionedTail) {
      for (const entry of verifyPartitionRange(input.repo, tailBase, source))
        add(entry.commit, entry.metadata);
    } else {
      for (const squashCommit of tail) {
        for (const entry of expandSquashCommit(input.repo, squashCommit))
          add(entry.commit, entry.metadata);
      }
    }
  }

  return {
    items: normalizeCarryDeletions(input.repo, items, grouped),
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
  const path = carryPlanPath(worktree);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(plan, undefined, 2)}\n`, {
    mode: 0o600,
    flush: true,
  });
  NodeFS.renameSync(temporaryPath, path);
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
  const status = runGit(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    const diff = runGit(worktree, ["diff", "--raw", "--no-abbrev"])
      .split("\n")
      .slice(0, 20)
      .join("\n");
    throw new Error(
      `Carry replay worktree must be clean before replay starts.\n${status.split("\n").slice(0, 20).join("\n")}\n${diff}`,
    );
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
  return createCommit(repo, resolveTree(repo, base), base, message, environment);
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
        "-c",
        "rerere.enabled=false",
        "-c",
        "rerere.autoupdate=false",
        "rebase",
        "--interactive",
        "--onto",
        input.onto,
        input.upstream,
        "--keep-empty",
        "--empty=keep",
        "--reapply-cherry-picks",
      ],
      { environment, timeout: 10 * 60_000 },
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

export function completeCarryReplay(
  worktree: string,
  options: { readonly reselect?: boolean } = {},
): CarryReplayResult {
  const plan = readCarryReplayPlan(worktree);
  if (!plan) throw new Error("Carry replay worktree has no persisted plan.");
  if (rebaseInProgress(worktree))
    throw new Error("Carry replay still has unresolved rebase state.");
  const previousHead = resolveCommit(worktree, "HEAD");
  if (
    plan.status === "complete" &&
    (!plan.resultHead ||
      !isCheckpointMessageRewrite(worktree, plan.onto, plan.resultHead, previousHead))
  ) {
    // Only explicit selection may fold committed repairs into the owning groups.
    // Ordinary retries still reject a head that differs from the saved plan.
    if (options.reselect && plan.resultHead && plan.phase !== "historical") {
      return compileCarrySetSameBase({
        repo: worktree,
        worktree,
        base: plan.onto,
        source: previousHead,
        previousCompactHead: plan.resultHead,
        partitionedTail: true,
      });
    }
    throw new Error(
      `Completed carry replay recorded ${plan.resultHead ?? "no head"}, found ${previousHead}.`,
    );
  }
  const previousGroups =
    plan.phase === "historical"
      ? undefined
      : readCarryGroupChain(worktree, previousHead, plan.onto);
  if (
    plan.phase === "compile" &&
    plan.expectedSourceTree !== undefined &&
    resolveTree(worktree, previousHead) !== plan.expectedSourceTree
  ) {
    throw new Error("Compiled carry tree does not equal the expected source tree.");
  }
  // Normalize before recording the completed head: validation and recovery must
  // refer to the exact commits that will be published, including old metadata.
  const head = normalizeCheckpointCommits(worktree, plan.onto);
  const groups =
    head === previousHead || plan.phase === "historical"
      ? previousGroups
      : readCarryGroupChain(worktree, head, plan.onto);
  if (plan.status !== "complete" || plan.resultHead !== head) finishPlan(worktree, plan, head);
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
    ...(input.partitionedTail ? { partitionedTail: true } : {}),
  });
  const anchors = new Map(
    CARRY_REPLAY_GROUPS.map((group) => [
      group,
      createAnchor(input.repo, base, group, groupMessage(group, expanded.contributions[group])),
    ]),
  );
  const todo: string[] = [];
  for (const group of CARRY_REPLAY_GROUPS) {
    const label = `carry-group-${group}`;
    todo.push(`pick ${anchors.get(group)} carry(${group}): compile downstream group`);
    todo.push(`label ${label}`);
    const items = expanded.items.filter((candidate) => candidate.group === group);
    for (const item of items) {
      todo.push(`pick ${item.commit} ${commitSubject(input.repo, item.commit)}`);
    }
    if (items.length > 0) {
      // A contribution can cancel the group's entire delta. Git's fixup refuses
      // that empty amend, but the ordered carry chain must still retain the group.
      // Conflict recovery can drop empty picks, so return to the recorded anchor.
      const git = "git -c core.hooksPath=/dev/null -c commit.gpgSign=false";
      todo.push(
        `exec ${git} reset --soft refs/rewritten/${label} && ${git} commit --amend --allow-empty --no-edit`,
      );
    }
  }
  const previousCompactHead = input.previousCompactHead
    ? resolveCommit(input.repo, input.previousCompactHead)
    : undefined;
  const representedSource = input.representedSource
    ? resolveCommit(input.repo, input.representedSource)
    : undefined;
  const preparedSource = input.preparedPartition
    ? resolveCommit(input.repo, input.preparedPartition.source)
    : undefined;
  const crossBasePreparedPartition =
    preparedSource !== undefined &&
    representedSource !== undefined &&
    preparedSource !== representedSource;
  const sameBaseCompilation =
    (input.preparedPartition !== undefined && !crossBasePreparedPartition) ||
    (previousCompactHead !== undefined && isAncestor(input.repo, previousCompactHead, source));
  startPlan(input.worktree, {
    phase: "compile",
    source,
    sourceBase: base,
    onto: base,
    ...(sameBaseCompilation ? { expectedSourceTree: resolveTree(input.repo, source) } : {}),
  });
  try {
    runInteractiveReplay({
      worktree: input.worktree,
      upstream: input.preparedPartition ? base : (representedSource ?? base),
      onto: base,
      todo,
    });
  } catch (error) {
    let conflict: RegroupConflict | undefined;
    try {
      // Cross-base tails were written against another tree, so their conflicts may not be regrouping.
      conflict =
        sameBaseCompilation && rebaseInProgress(input.worktree)
          ? describeRegroupConflict(input.repo, input.worktree, expanded.items)
          : undefined;
    } catch {
      // The diagnosis is advisory; the replay failure is the error that matters.
    }
    if (!conflict) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CarryReplayConflictError(conflict, detail, { cause: error });
  }
  return completeCarryReplay(input.worktree);
}

interface RegroupConflict {
  readonly diagnosis: string;
  readonly advice: string;
}

// @effect-diagnostics-next-line extendsNativeError:off -- Plain Git orchestration; callers use instanceof.
export class CarryReplayConflictError extends Error {
  override readonly name = "CarryReplayConflictError";
  readonly diagnosis: string;
  // Retagging applies only to unmerged sources, so callers decide whether to show it.
  readonly advice: string;
  readonly gitOutput: string;

  constructor(conflict: RegroupConflict, gitOutput: string, options?: ErrorOptions) {
    // Bounded failure records keep the tail, so the diagnosis goes last.
    super(`Git output:\n${gitOutput}\n${conflict.diagnosis}`, options);
    this.diagnosis = conflict.diagnosis;
    this.advice = conflict.advice;
    this.gitOutput = gitOutput;
  }
}

function changedPaths(
  repo: string,
  commits: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const result = new Map<string, ReadonlyArray<string>>();
  if (commits.length === 0 || paths.length === 0) return result;
  const output = runGit(
    repo,
    [
      "--literal-pathspecs",
      "log",
      "--no-walk=unsorted",
      "--stdin",
      "--format=%x01%H",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
      ...paths,
    ],
    { input: `${Array.from(new Set(commits)).join("\n")}\n`, raw: true },
  );
  for (const chunk of output.split("\x01").slice(1)) {
    const [commit, ...rest] = chunk.split("\0");
    const touched = rest.map((path) => path.replace(/^\n/u, "")).filter(Boolean);
    if (commit && touched.length > 0) result.set(commit, touched);
  }
  return result;
}

function blame(repo: string, args: ReadonlyArray<string>, path: string) {
  const output = runGit(repo, ["blame", "--porcelain", ...args, "--", path], {
    allowFailure: true,
  });
  const lines: Array<{ readonly commit: string; readonly line: number }> = [];
  // A boundary commit only marks where a range blame stopped; it did not change the line.
  const boundaries = new Set<string>();
  let commit = "";
  for (const entry of output.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) \d+/u.exec(entry);
    if (header) {
      commit = header[1]!;
      lines.push({ commit, line: Number(header[2]) });
    } else if (entry === "boundary") boundaries.add(commit);
  }
  return lines.filter((line) => !boundaries.has(line.commit));
}

// Git conflicts on overlapping or adjacent hunks, so take the stopped commit's
// old-side lines widened by one; an insertion touches only its two neighbours.
function conflictRanges(
  repo: string,
  parent: string,
  stopped: string,
  path: string,
): ReadonlyArray<string> {
  const contents = runGit(repo, ["cat-file", "-p", `${parent}:${path}`], {
    allowFailure: true,
    raw: true,
  });
  const lineCount = contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0);
  const diff = runGit(repo, [
    "--literal-pathspecs",
    "diff",
    "-U0",
    "--no-renames",
    "--no-ext-diff",
    parent,
    stopped,
    "--",
    path,
  ]);
  return Array.from(diff.matchAll(/^@@ -(\d+)(?:,(\d+))? /gmu)).flatMap((hunk) => {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const low = Math.max(1, count === 0 ? start : start - 1);
    const high = Math.min(lineCount, count === 0 ? start + 1 : start + count);
    return low <= high ? ["-L", `${low},${high}`] : [];
  });
}

// Grouping replays each group's contributions together, in CARRY_REPLAY_GROUPS
// order. A contribution that edits lines a later group changed earlier in
// history therefore replays before the changes it was written against.
function describeRegroupConflict(
  repo: string,
  worktree: string,
  items: ReadonlyArray<ReplayItem>,
): RegroupConflict | undefined {
  const stopped = runGit(worktree, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], {
    allowFailure: true,
  });
  const index = items.findIndex((item) => item.commit === stopped);
  const current = items[index];
  const parent = current ? commitParents(repo, current.commit)[0] : undefined;
  const files = runGit(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"], { raw: true })
    .split("\0")
    .filter(Boolean);
  if (!current?.metadata || !parent || files.length === 0) return undefined;
  const rank = (group: CarryReplayGroup) => CARRY_REPLAY_GROUPS.indexOf(group);
  const candidates = items.slice(0, index).filter((item) => rank(item.group) > rank(current.group));
  if (candidates.length === 0) return undefined;

  // History names a contribution by its source commit, or by the squash or compiled
  // group commit that published it.
  const owners = new Map<string, ReplayItem[]>();
  const own = (commit: string, item: ReplayItem) =>
    owners.set(commit, [...(owners.get(commit) ?? []), item]);
  for (const item of candidates) {
    own(item.commit, item);
    if (item.metadata) own(item.metadata.sourceCommit, item);
  }
  const blamedSources = (path: string): ReadonlyArray<string> => {
    const ranges = conflictRanges(repo, parent, current.commit, path);
    if (ranges.length === 0) return [];
    const blamed = new Map<string, number[]>();
    for (const { commit, line } of blame(repo, [...ranges, parent], path)) {
      blamed.set(commit, [...(blamed.get(commit) ?? []), line]);
    }
    const sources = new Set(blamed.keys());
    for (const [commit, lineNumbers] of blamed) {
      const { sourceBase, sourceHead } = parseCarryTrailers(commitMessage(repo, commit));
      // A squash stands for a whole PR; blame its lines again inside the retained source
      // range. Line numbers only carry over when the squash tree is the source head's.
      if (!sourceBase || !sourceHead) continue;
      if (resolveTree(repo, commit) !== resolveTree(repo, sourceHead)) continue;
      const lines = Array.from(new Set(lineNumbers)).flatMap((line) => ["-L", `${line},${line}`]);
      for (const { commit: source } of blame(
        repo,
        [...lines, `${sourceBase}..${sourceHead}`],
        path,
      ))
        sources.add(source);
    }
    return Array.from(sources);
  };
  const touchedBy = changedPaths(
    repo,
    candidates.map((item) => item.commit),
    files,
  );

  const found = new Map<ReplayItem, Set<string>>();
  const unexplained: string[] = [];
  const wholeFile = new Set<string>();
  for (const path of files) {
    let owning = blamedSources(path)
      .flatMap((commit) => owners.get(commit) ?? [])
      .filter((item) => touchedBy.get(item.commit)?.includes(path));
    // Blame cannot see through every rewrite; fall back to any later-group change to the file.
    if (owning.length === 0) {
      owning = candidates.filter((item) => touchedBy.get(item.commit)?.includes(path));
      if (owning.length > 0) wholeFile.add(path);
    }
    if (owning.length === 0) unexplained.push(path);
    for (const item of owning) found.set(item, (found.get(item) ?? new Set()).add(path));
  }
  if (found.size === 0) return undefined;

  const label = (item: ReplayItem) => {
    if (!item.metadata) return `compiled ${item.group} group commit ${item.commit.slice(0, 12)}`;
    const { sourceCommit, subject } = item.metadata;
    const partition = item.metadata.metadata?.["Carry-Observation"]?.some((observation) =>
      observation.startsWith("Deletion partition follows the "),
    );
    const source = partition
      ? parseCarryTrailers(commitMessage(repo, sourceCommit)).group
      : item.group;
    const note =
      source && source !== item.group ? `; deletion partition replayed with ${item.group}` : "";
    return `${sourceCommit.slice(0, 12)} "${subject}" (Carry-Group: ${source ?? item.group}${note})`;
  };
  const owning = candidates.filter((item) => found.has(item));
  const target = owning.reduce(
    (latest, item) => (rank(item.group) > rank(latest) ? item.group : latest),
    current.group,
  );
  const overlap = files.filter((path) => !unexplained.includes(path));
  const followers = items
    .slice(index + 1)
    .filter(
      (item) =>
        item.metadata && rank(item.group) >= rank(current.group) && rank(item.group) < rank(target),
    );
  const followerPaths = changedPaths(
    repo,
    followers.map((item) => item.commit),
    overlap,
  );
  const following = followers.filter((item) => followerPaths.has(item.commit));
  const replaying = current.metadata.sourceCommit.slice(0, 12);
  return {
    diagnosis: [
      `Carry replay conflicted in ${files.join(", ")} while replaying ${label(current)}.`,
      "These commits in later carry groups changed those lines earlier in history, so the replay has not applied them yet:",
      ...owning.map(
        (item) =>
          `- ${label(item)}: ${Array.from(found.get(item)!, (path) => (wholeFile.has(path) ? `${path} (somewhere in the file; blame found no later-group line)` : path)).join(", ")}`,
      ),
      ...(unexplained.length > 0
        ? [
            `No later carry group changes ${unexplained.join(", ")} earlier in history; that conflict has another cause.`,
          ]
        : []),
    ].join("\n"),
    advice: [
      `Likely fix: retag ${replaying}'s Carry-Group to ${target} so it replays after them, or split its changes to ${overlap.join(", ")} into a separate ${target} commit.`,
      ...(following.length > 0
        ? [
            `These later commits also edit those files and would still replay before ${target}; move them the same way:`,
            ...following.map((item) => `- ${label(item)}`),
          ]
        : []),
    ].join("\n"),
  };
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
  try {
    runInteractiveReplay({
      worktree: input.worktree,
      upstream: sourceBase,
      onto,
      todo: groups.map(({ commit, group }) => `pick ${commit} carry(${group})`),
    });
  } catch (error) {
    try {
      const conflictDossierPath = writeCarryConflictDossier(
        { ...input, sourceBase, compactHead, onto },
        groups,
      );
      if (conflictDossierPath && error instanceof Error)
        Object.assign(error, { conflictDossierPath });
    } catch (dossierError) {
      console.warn(
        `[lastcode:checkpoint] Could not write conflict dossier: ${dossierError instanceof Error ? dossierError.message : String(dossierError)}`,
      );
    }
    throw error;
  }
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
    upstream,
    onto,
    todo,
  });
  return completeCarryReplay(input.worktree);
}
