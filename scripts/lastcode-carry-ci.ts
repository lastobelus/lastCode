#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- CI validates exact Git objects from the pull-request event.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  parseManifestReplayConfiguration,
  validateHistoricalBootstrapSourceTag,
  type CarryBootstrap,
} from "./lastcode-carry-checkpoint.ts";
import { cleanGitEnvironment } from "./lib/lastcode-git.ts";
import { parseLastCodeInstallableTag } from "./lib/lastcode-installable-tag.ts";

import {
  carrySquashBody,
  shouldRetainCarrySources,
  validateCarrySourceRange,
  type CarryReplayManifest,
  type CarrySourceDelivery,
} from "./lastcode-carry-delivery.ts";
import {
  CARRY_REPLAY_GROUPS,
  CarryReplayConflictError,
  compileCarrySetSameBase,
  parseCarryTrailers,
  readCarryGroupChain,
} from "./lastcode-carry-replay.ts";

const CARRY_MANIFEST_PATH = "scripts/lastcode-carry-set.json";

export interface CarryCiPullRequest {
  readonly base: string;
  readonly head: string;
  readonly number: number;
}

export interface CarryCiResult {
  readonly active: boolean;
  readonly source?: CarrySourceDelivery;
  readonly compilation?: {
    readonly upstream: string;
    readonly sourceTree: string;
    readonly compiledTree: string;
  };
}

function git(
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean; readonly input?: string } = {},
): string | undefined {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: cleanGitEnvironment(process.env),
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return undefined;
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function exactCommit(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`Carry CI requires the exact 40-character pull-request ${name} commit.`);
  }
  return value;
}

function assertCommitAvailable(repoRoot: string, commit: string): void {
  if (
    git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`], { allowFailure: true }) !==
    commit
  ) {
    throw new Error(
      `Pull-request commit ${commit} is unavailable. Fetch the complete base-to-head history before validating carry groups.`,
    );
  }
}

function manifestAt(repoRoot: string, treeish: string): CarryReplayManifest | undefined {
  const contents = git(repoRoot, ["show", `${treeish}:${CARRY_MANIFEST_PATH}`], {
    allowFailure: true,
  });
  if (contents === undefined) return undefined;
  const manifest: unknown = JSON.parse(contents);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${CARRY_MANIFEST_PATH} at ${treeish} must contain a JSON object.`);
  }
  return manifest as CarryReplayManifest;
}

// The squash GitHub publishes for a PR behind its base: the PR's changes since its fork point,
// merged onto the current base tip.
function landingTree(repoRoot: string, mergeBase: string, target: string, head: string): string {
  const tree = git(
    repoRoot,
    ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${mergeBase}`, target, head],
    { allowFailure: true },
  );
  if (tree === undefined || !/^[0-9a-f]{40}$/u.test(tree)) {
    throw new Error(
      `Head ${head} conflicts with base ${target}. Rebase onto the current base and push.`,
    );
  }
  return tree;
}

function compactBase(repoRoot: string, sourceBase: string) {
  const candidates = git(repoRoot, [
    "log",
    "--first-parent",
    "--format=%H",
    "--grep=^Carry-Group: incubator$",
    sourceBase,
  ])!
    .split("\n")
    .filter(Boolean);
  for (const head of candidates) {
    const base = git(repoRoot, ["rev-parse", "--verify", `${head}~${CARRY_REPLAY_GROUPS.length}`], {
      allowFailure: true,
    });
    if (!base) continue;
    try {
      readCarryGroupChain(repoRoot, head, base);
      return { base, head };
    } catch {
      // Individual contributions can name the last group too; only a full chain qualifies.
    }
  }
  return undefined;
}

// Walks back over a topic branch's unsquashed parent contributions to where they start.
function topicBase(repoRoot: string, start: string, stop: string): string {
  let base = start;
  while (base !== stop) {
    const trailers = parseCarryTrailers(git(repoRoot, ["show", "-s", "--format=%B", base])!);
    if (!trailers.group || trailers.sourceRef || trailers.sourceBase || trailers.sourceHead) break;
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", base])!.split(/\s+/u);
    if (parents.length !== 2) throw new Error(`Topic carry source ${base} must be single-parent.`);
    base = parents[1]!;
  }
  return base;
}

// A child retargeted after its parent squash-merged still holds the parent's original commits,
// which the base already carries. Returns the newest such commit in the PR's range.
function landedParentHead(
  repoRoot: string,
  base: string,
  target: string,
  head: string,
): string | undefined {
  if (base === target) return undefined;
  const landed = new Set<string>();
  const messages = git(repoRoot, [
    "log",
    "--format=%B%x00",
    "-E",
    "--grep=^Carry-(Source-Head|Contribution):",
    `${base}..${target}`,
  ])!;
  for (const message of messages.split("\0")) {
    const trailers = parseCarryTrailers(message);
    if (trailers.sourceHead) landed.add(trailers.sourceHead);
    if (trailers.sourceBase && trailers.sourceHead) {
      const range = `${exactCommit(trailers.sourceBase, "source base")}..${exactCommit(trailers.sourceHead, "source head")}`;
      for (const commit of git(repoRoot, ["rev-list", range])!.split("\n").filter(Boolean)) {
        landed.add(commit);
      }
    }
    for (const contribution of trailers.contributions) landed.add(contribution.sourceCommit);
  }
  if (landed.size === 0) return undefined;
  return git(repoRoot, ["rev-list", `${base}..${head}`])!
    .split("\n")
    .find((commit) => landed.has(commit));
}

function fetchBootstrapObjects(repoRoot: string, bootstrap: CarryBootstrap): void {
  const ref = bootstrap.ref;
  if (ref === undefined) return;
  if (
    !ref.startsWith("refs/") ||
    git(repoRoot, ["check-ref-format", ref], { allowFailure: true }) === undefined
  ) {
    throw new Error("Carry bootstrap ref must be a fully qualified Git ref.");
  }
  const remote = git(repoRoot, ["ls-remote", "--refs", "origin", ref]);
  if (remote !== `${bootstrap.head}\t${ref}`) {
    throw new Error(
      `Carry bootstrap ref ${ref} on origin must equal pinned head ${bootstrap.head}.`,
    );
  }
  // Empty refmap suppresses configured tracking updates; only the pinned objects may enter the caller.
  git(repoRoot, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--refmap=",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    "origin",
    bootstrap.head,
  ]);
}

function compilePullRequest(
  repoRoot: string,
  source: CarrySourceDelivery,
  manifest: CarryReplayManifest,
  target: string,
): NonNullable<CarryCiResult["compilation"]> {
  const compact = compactBase(repoRoot, target);
  const bootstrap = parseManifestReplayConfiguration(manifest)?.bootstrap;
  if (!compact && !bootstrap) {
    throw new Error("No compact carry chain or prepared bootstrap is available at the PR base.");
  }
  if (bootstrap) fetchBootstrapObjects(repoRoot, bootstrap);
  let representedSource: string | undefined;
  if (!compact && bootstrap?.sourceTag) {
    const tagRef = `refs/tags/${bootstrap.sourceTag}`;
    const commit = parseLastCodeInstallableTag(bootstrap.sourceTag)
      ? git(repoRoot, ["rev-list", "-n", "1", tagRef], { allowFailure: true })
      : undefined;
    representedSource = validateHistoricalBootstrapSourceTag(
      bootstrap,
      commit
        ? {
            commit,
            annotated: git(repoRoot, ["cat-file", "-t", tagRef]) === "tag",
            message: git(repoRoot, ["for-each-ref", tagRef, "--format=%(contents)"])!,
          }
        : undefined,
    );
  }
  // A topic base can end in unsquashed parent contributions. Model the whole
  // unpublished tail together, while retaining the child's actual delivery range.
  const stop = compact?.head ?? representedSource ?? bootstrap!.source;
  const compilationSource = { ...source, base: topicBase(repoRoot, source.base, stop) };
  const behind = source.base !== target;
  const temporaryRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-carry-admission-"),
  );
  const isolated = NodePath.join(temporaryRoot, "repo");
  try {
    // An independent repository keeps rebase state, refs, hooks and rerere away from the caller.
    git(repoRoot, [
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      "--",
      repoRoot,
      isolated,
    ]);
    git(isolated, ["config", "core.hooksPath", "/dev/null"]);
    git(isolated, ["config", "rerere.enabled", "false"]);
    git(isolated, ["config", "user.name", "LastCode carry admission"]);
    git(isolated, ["config", "user.email", "carry-admission@example.invalid"]);
    const retained = git(repoRoot, [
      "for-each-ref",
      "--format=update %(refname) %(objectname)",
      "refs/lastcode/carry-sources/",
    ]);
    if (retained) git(isolated, ["update-ref", "--stdin"], { input: `${retained}\n` });
    git(isolated, ["update-ref", source.ref, source.head]);
    // Model the exact squash that guarded merge will publish, without publishing its source ref.
    // Behind its base, that squash lands on the current tip, whose tail replays on its own.
    const sourceTree = behind
      ? landingTree(isolated, source.base, target, source.head)
      : git(repoRoot, ["rev-parse", `${source.head}^{tree}`])!;
    const squash = git(isolated, [
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      sourceTree,
      "-p",
      behind ? target : compilationSource.base,
      "-m",
      carrySquashBody("Carry admission candidate", behind ? source : compilationSource),
    ])!;
    // Materialize every tracked file even when an existing index already matches this tree.
    git(isolated, ["checkout", "--quiet", "--force", "--detach", squash]);
    const result = compileCarrySetSameBase({
      repo: isolated,
      worktree: isolated,
      base: compact?.base ?? bootstrap!.base,
      source: squash,
      ...(compact
        ? { previousCompactHead: compact.head }
        : {
            preparedPartition: bootstrap!,
            ...(representedSource ? { representedSource } : {}),
          }),
    });
    const compiledTree = git(isolated, ["rev-parse", `${result.head}^{tree}`])!;
    if (compiledTree !== sourceTree) {
      throw new Error(
        `Compiled carry tree ${compiledTree} does not equal PR source tree ${sourceTree}.`,
      );
    }
    return { upstream: result.onto, sourceTree, compiledTree };
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateCarryPullRequest(
  repoRoot: string,
  pullRequest: CarryCiPullRequest,
): CarryCiResult {
  const target = exactCommit(pullRequest.base, "base");
  const head = exactCommit(pullRequest.head, "head");
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw new Error("Carry CI requires a positive pull-request number.");
  }
  assertCommitAvailable(repoRoot, target);
  assertCommitAvailable(repoRoot, head);
  // A PR may be behind its base; its own source range starts where it forked.
  const base = git(repoRoot, ["merge-base", target, head])!;
  const targetManifest = manifestAt(repoRoot, target);
  // Before the landing merge, which a merged parent's stale commits can make conflict.
  const landed =
    targetManifest && shouldRetainCarrySources(targetManifest)
      ? landedParentHead(repoRoot, base, target, head)
      : undefined;
  if (landed) {
    throw new Error(
      `PR #${pullRequest.number} still contains commits through ${landed} that already landed in base ${target} through a merged parent PR. Restack only its own commits with \`git rebase --onto ${target} ${landed}\` and push.`,
    );
  }
  if (base !== target) {
    const carryManifest = [targetManifest, manifestAt(repoRoot, head)].find(
      (manifest) => manifest && shouldRetainCarrySources(manifest),
    );
    if (carryManifest) {
      const stop =
        compactBase(repoRoot, target)?.head ??
        parseManifestReplayConfiguration(carryManifest)?.bootstrap?.source;
      if (stop && topicBase(repoRoot, target, stop) !== target) {
        throw new Error(
          `PR #${pullRequest.number} forked from ${base}, behind its topic base ${target}, whose parent commits have not squash-merged yet. Rebase onto the topic base with \`git rebase --onto ${target} ${base}\` and push.`,
        );
      }
    }
  }
  const manifests = [
    targetManifest,
    manifestAt(repoRoot, base === target ? head : landingTree(repoRoot, base, target, head)),
  ];
  const active = manifests.some(
    (manifest) => manifest !== undefined && shouldRetainCarrySources(manifest),
  );
  if (!active) return { active: false };

  let source: CarrySourceDelivery;
  try {
    source = validateCarrySourceRange(repoRoot, pullRequest.number, base, head);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PR #${pullRequest.number} carry validation failed for exact range ${base}..${head}: ${detail} Add exactly one Carry-Group trailer to every commit using one of: ${CARRY_REPLAY_GROUPS.join(", ")}. Keep the PR history linear, then push the corrected head.`,
      { cause: error },
    );
  }
  try {
    parseManifestReplayConfiguration(manifests[1]);
    const manifest = [...manifests]
      .reverse()
      .find((candidate) => candidate && shouldRetainCarrySources(candidate))!;
    return {
      active: true,
      source,
      compilation: compilePullRequest(repoRoot, source, manifest, target),
    };
  } catch (error) {
    const detail =
      error instanceof CarryReplayConflictError
        ? `${error.diagnosis}\n${error.advice}\nPush the corrected head and rerun carry validation before merging.\nGit output:\n${error.gitOutput}`
        : `${error instanceof Error ? error.message : String(error)} Reconcile the source contributions with their owning groups and rerun carry validation before merging.`;
    throw new Error(
      `PR #${pullRequest.number} same-base carry compilation failed for ${base}..${head}: ${detail}`,
      { cause: error },
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Carry CI requires ${name}.`);
  return value;
}

export function pullRequestFromEnvironment(): CarryCiPullRequest {
  const number = Number(requiredEnvironment("PR_NUMBER"));
  return {
    base: requiredEnvironment("BASE_SHA"),
    head: requiredEnvironment("HEAD_SHA"),
    number,
  };
}

if (import.meta.main) {
  try {
    const pullRequest = pullRequestFromEnvironment();
    const result = validateCarryPullRequest(process.cwd(), pullRequest);
    if (result.active) {
      console.log(
        `[lastcode:carry-ci] Validated Carry-Group assignments and exact same-base compiled tree for PR #${pullRequest.number} at ${pullRequest.base}..${pullRequest.head}.`,
      );
    } else {
      console.log("[lastcode:carry-ci] Carry replay is inactive on both PR base and head.");
    }
  } catch (error) {
    console.error(`[lastcode:carry-ci] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
