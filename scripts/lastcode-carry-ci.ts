#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- CI validates exact Git objects from the pull-request event.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  parseManifestReplayConfiguration,
  type CarryBootstrap,
} from "./lastcode-carry-checkpoint.ts";
import { cleanGitEnvironment } from "./lastcode-nightly.ts";

import {
  carrySquashBody,
  shouldRetainCarrySources,
  validateCarrySourceRange,
  type CarryReplayManifest,
  type CarrySourceDelivery,
} from "./lastcode-carry-delivery.ts";
import {
  CARRY_REPLAY_GROUPS,
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

function manifestAtCommit(repoRoot: string, commit: string): CarryReplayManifest | undefined {
  if (
    git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`], { allowFailure: true }) !==
    commit
  ) {
    throw new Error(
      `Pull-request commit ${commit} is unavailable. Fetch the complete base-to-head history before validating carry groups.`,
    );
  }
  const contents = git(repoRoot, ["show", `${commit}:${CARRY_MANIFEST_PATH}`], {
    allowFailure: true,
  });
  if (contents === undefined) return undefined;
  const manifest: unknown = JSON.parse(contents);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${CARRY_MANIFEST_PATH} at ${commit} must contain a JSON object.`);
  }
  return manifest as CarryReplayManifest;
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

function includeTopicBase(repoRoot: string, source: CarrySourceDelivery, stop: string) {
  let base = source.base;
  while (base !== stop) {
    const trailers = parseCarryTrailers(git(repoRoot, ["show", "-s", "--format=%B", base])!);
    if (!trailers.group || trailers.sourceRef || trailers.sourceBase || trailers.sourceHead) break;
    const parents = git(repoRoot, ["rev-list", "--parents", "-n", "1", base])!.split(/\s+/u);
    if (parents.length !== 2) throw new Error(`Topic carry source ${base} must be single-parent.`);
    base = parents[1]!;
  }
  return { ...source, base };
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
): NonNullable<CarryCiResult["compilation"]> {
  const compact = compactBase(repoRoot, source.base);
  const bootstrap = compact ? undefined : parseManifestReplayConfiguration(manifest)?.bootstrap;
  if (!compact && !bootstrap) {
    throw new Error("No compact carry chain or prepared bootstrap is available at the PR base.");
  }
  if (bootstrap) fetchBootstrapObjects(repoRoot, bootstrap);
  // A topic base can end in unsquashed parent contributions. Model the whole
  // unpublished tail together, while retaining the child's actual delivery range.
  const compilationSource = includeTopicBase(
    repoRoot,
    source,
    compact?.head ?? bootstrap!.representedSource ?? bootstrap!.source,
  );
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
    const sourceTree = git(repoRoot, ["rev-parse", `${source.head}^{tree}`])!;
    // Model the exact squash that guarded merge will publish, without publishing its source ref.
    const squash = git(isolated, [
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      sourceTree,
      "-p",
      compilationSource.base,
      "-m",
      carrySquashBody("Carry admission candidate", compilationSource),
    ])!;
    git(isolated, ["checkout", "--quiet", "--detach", squash]);
    const result = compileCarrySetSameBase({
      repo: isolated,
      worktree: isolated,
      base: compact?.base ?? bootstrap!.base,
      source: squash,
      ...(compact
        ? { previousCompactHead: compact.head }
        : {
            preparedPartition: bootstrap!,
            ...(bootstrap!.representedSource
              ? { representedSource: bootstrap!.representedSource }
              : {}),
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
  const base = exactCommit(pullRequest.base, "base");
  const head = exactCommit(pullRequest.head, "head");
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0) {
    throw new Error("Carry CI requires a positive pull-request number.");
  }
  const manifests = [manifestAtCommit(repoRoot, base), manifestAtCommit(repoRoot, head)];
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
    return {
      active: true,
      source,
      compilation: compilePullRequest(
        repoRoot,
        source,
        manifests.find((manifest) => manifest && shouldRetainCarrySources(manifest))!,
      ),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PR #${pullRequest.number} same-base carry compilation failed for ${base}..${head}: ${detail} Reconcile the source contributions with their owning groups and rerun carry validation before merging.`,
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
