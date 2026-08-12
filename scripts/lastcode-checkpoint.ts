#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  checkpointTagFromNightlyTag,
  compareNightlyTags,
  type NightlyTag,
  nightlyTagFromCheckpointTag,
  parseNightlyTag,
  resolveLatestNightlyTag,
  resolveUncheckpointedNightlies,
} from "./lastcode-nightly.ts";

const DEFAULT_SOURCE_REF = "refs/remotes/origin/lastcode/main";
const DEFAULT_UPSTREAM_REMOTE = "upstream";
const DEFAULT_PUSH_REMOTE = "origin";
const CHECKPOINT_TAG_GLOB = "lastcode/checkpoint/v*-nightly.*";

export type PromotionMode = "never" | "always" | "if-no-open-prs";

interface CheckpointOptions {
  readonly dryRun: boolean;
  readonly fetch: boolean;
  readonly promotion: PromotionMode;
  readonly pushTags: boolean;
  readonly smoke: boolean;
  readonly sourceRef: string;
  readonly upstreamRemote: string;
  readonly pushRemote: string;
}

interface CheckpointRef {
  readonly checkpointTag: string;
  readonly commit: string;
  readonly nightly: NightlyTag;
}

export interface CheckpointPlan {
  readonly baseNightly: NightlyTag;
  readonly bootstrapCheckpoint: boolean;
  readonly candidateRef: string;
  readonly missingNightlies: ReadonlyArray<NightlyTag>;
}

function run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly capture?: boolean; readonly allowFailure?: boolean } = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    const details = options.capture ? result.stderr.trim() : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`, details]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return options.capture ? result.stdout.trim() : "";
}

function git(
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean; readonly cwd?: string } = {},
): string {
  return run(options.cwd ?? repoRoot, "git", args, {
    capture: true,
    ...(options.allowFailure ? { allowFailure: true } : {}),
  });
}

function splitLines(value: string): ReadonlyArray<string> {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repoRoot, stdio: "ignore" },
  );
  if (result.error) throw result.error;
  return result.status === 0;
}

function listCheckpointRefs(repoRoot: string): ReadonlyArray<CheckpointRef> {
  return splitLines(git(repoRoot, ["tag", "--list", CHECKPOINT_TAG_GLOB]))
    .flatMap((checkpointTag) => {
      const nightlyTag = nightlyTagFromCheckpointTag(checkpointTag);
      const nightly = nightlyTag ? parseNightlyTag(nightlyTag) : undefined;
      return nightly
        ? [
            {
              checkpointTag,
              commit: git(repoRoot, ["rev-list", "-n", "1", checkpointTag]),
              nightly,
            },
          ]
        : [];
    })
    .toSorted((left, right) => compareNightlyTags(left.nightly, right.nightly));
}

function latestCheckpointAncestor(
  repoRoot: string,
  checkpoints: ReadonlyArray<CheckpointRef>,
  sourceRef: string,
): CheckpointRef | undefined {
  return checkpoints.findLast((checkpoint) => isAncestor(repoRoot, checkpoint.commit, sourceRef));
}

export function resolveCheckpointPlan(input: {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  readonly nightlyTags: ReadonlyArray<string>;
  readonly sourceCommit: string;
  readonly sourceCheckpointTag?: string;
  readonly sourceNightlyTags: ReadonlyArray<string>;
  readonly sourceRef: string;
}): CheckpointPlan {
  const latestCheckpoint = input.checkpointRefs.at(-1);
  const sourceCheckpoint = input.checkpointRefs.find(
    (checkpoint) => checkpoint.checkpointTag === input.sourceCheckpointTag,
  );
  const sourceBase = sourceCheckpoint?.nightly ?? resolveLatestNightlyTag(input.sourceNightlyTags);
  if (!sourceBase) {
    throw new Error(`${input.sourceRef} is not based on a recognizable upstream nightly tag.`);
  }

  const candidateRef =
    sourceCheckpoint &&
    sourceCheckpoint.commit === input.sourceCommit &&
    latestCheckpoint &&
    sourceCheckpoint.nightly.tag !== latestCheckpoint.nightly.tag
      ? latestCheckpoint.checkpointTag
      : input.sourceRef;
  const candidateBase = candidateRef === input.sourceRef ? sourceBase : latestCheckpoint?.nightly;
  if (!candidateBase) throw new Error("Could not resolve the LastCode checkpoint base.");

  const checkpointTags = input.checkpointRefs.map(({ checkpointTag }) => checkpointTag);
  const missingNightlies = resolveUncheckpointedNightlies(input.nightlyTags, checkpointTags).filter(
    (nightly) => compareNightlyTags(nightly, candidateBase) > 0,
  );

  return {
    baseNightly: candidateBase,
    bootstrapCheckpoint: !checkpointTags.includes(checkpointTagFromNightlyTag(candidateBase.tag)),
    candidateRef,
    missingNightlies,
  };
}

export function worktreeAddArgs(
  branch: string,
  worktree: string,
  candidateRef: string,
): ReadonlyArray<string> {
  return ["worktree", "add", "-b", branch, worktree, candidateRef];
}

export function worktreeVp(worktree: string): string {
  return NodePath.join(worktree, "node_modules", ".bin", "vp");
}

export function promotionNeeded(remoteCommit: string, checkpointCommit: string): boolean {
  return remoteCommit !== checkpointCommit;
}

function parseArgs(argv: ReadonlyArray<string>): CheckpointOptions {
  let dryRun = false;
  let fetch = true;
  let promotion: PromotionMode = "never";
  let pushTags = false;
  let smoke = true;
  let sourceRef = DEFAULT_SOURCE_REF;
  let upstreamRemote = DEFAULT_UPSTREAM_REMOTE;
  let pushRemote = DEFAULT_PUSH_REMOTE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-fetch") fetch = false;
    else if (arg === "--no-smoke") smoke = false;
    else if (arg === "--push-tags") pushTags = true;
    else if (arg === "--promote") promotion = "always";
    else if (arg === "--promote-if-no-open-prs") promotion = "if-no-open-prs";
    else if (arg === "--source-ref" || arg === "--upstream-remote" || arg === "--push-remote") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--source-ref") sourceRef = value;
      else if (arg === "--upstream-remote") upstreamRemote = value;
      else pushRemote = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  return { dryRun, fetch, promotion, pushTags, smoke, sourceRef, upstreamRemote, pushRemote };
}

function checkpointMessage(
  repoRoot: string,
  nightly: NightlyTag,
  commit: string,
  sourceRef: string,
): string {
  return [
    `LastCode checkpoint for ${nightly.tag}`,
    "",
    `Upstream-Tag: ${nightly.tag}`,
    `Upstream-Commit: ${git(repoRoot, ["rev-parse", `${nightly.tag}^{commit}`])}`,
    `LastCode-Commit: ${commit}`,
    `Source-Ref: ${sourceRef}`,
    `Created-At: ${new Date().toISOString()}`,
  ].join("\n");
}

function createCheckpointTag(
  repoRoot: string,
  nightly: NightlyTag,
  commit: string,
  sourceRef: string,
): string {
  const checkpointTag = checkpointTagFromNightlyTag(nightly.tag);
  git(repoRoot, [
    "tag",
    "--annotate",
    checkpointTag,
    commit,
    "--message",
    checkpointMessage(repoRoot, nightly, commit, sourceRef),
  ]);
  return checkpointTag;
}

function assertForkInvariants(worktree: string): void {
  const requiredText = new Map([
    ["packages/shared/src/desktopDistribution.ts", "codes.lastobelus.lastcode"],
    ["apps/web/src/components/branding/LastCodeWordmark.tsx", "LastCode"],
    ["scripts/lastcode-build-mac-arm64.ts", "lastcode/checkpoint/"],
  ]);
  for (const [relativePath, expected] of requiredText) {
    const path = NodePath.join(worktree, relativePath);
    if (!NodeFS.existsSync(path) || !NodeFS.readFileSync(path, "utf8").includes(expected)) {
      throw new Error(
        `Checkpoint smoke invariant failed: ${relativePath} must contain '${expected}'.`,
      );
    }
  }
  run(worktree, "git", ["diff", "--check"]);
}

function runSmokeGate(worktree: string): void {
  console.log("[lastcode:checkpoint] Installing checkpoint worktree dependencies...");
  run(worktree, "vp", ["install", "--frozen-lockfile"]);
  assertForkInvariants(worktree);
  const vp = worktreeVp(worktree);
  run(worktree, vp, [
    "test",
    "run",
    "scripts/lastcode-nightly.test.ts",
    "scripts/lastcode-checkpoint.test.ts",
    "scripts/lastcode-local-ci.test.ts",
    "scripts/build-desktop-artifact.test.ts",
    "apps/desktop/src/electron/ElectronProtocol.test.ts",
  ]);
  run(worktree, vp, ["run", "--filter", "@t3tools/scripts", "typecheck"]);
}

function notify(platform: NodeJS.Platform, title: string, message: string): void {
  if (platform !== "darwin") return;
  run(
    process.cwd(),
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ],
    { allowFailure: true },
  );
}

function resolveAutomationWorktree(repoRoot: string): string {
  const primaryWorktree = splitLines(git(repoRoot, ["worktree", "list", "--porcelain"]))
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!primaryWorktree) throw new Error("Could not resolve the repository's primary worktree.");
  return NodePath.join(
    NodePath.dirname(primaryWorktree),
    `${NodePath.basename(primaryWorktree)}-worktrees`,
    "lastcode-nightly-sync",
  );
}

function openPullRequestCount(repoRoot: string): number {
  const value = run(
    repoRoot,
    "gh",
    [
      "pr",
      "list",
      "--base",
      "lastcode/main",
      "--state",
      "open",
      "--json",
      "number",
      "--jq",
      "length",
    ],
    { capture: true },
  );
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid gh PR count '${value}'.`);
  return count;
}

function promoteCheckpoint(
  repoRoot: string,
  commit: string,
  options: CheckpointOptions,
  platform: NodeJS.Platform,
): void {
  if (options.promotion === "never") return;
  git(repoRoot, ["fetch", options.pushRemote, "lastcode/main"]);
  const expected = git(repoRoot, ["rev-parse", `refs/remotes/${options.pushRemote}/lastcode/main`]);
  if (!promotionNeeded(expected, commit)) {
    console.log(
      `[lastcode:checkpoint] ${options.pushRemote}/lastcode/main is already at ${commit}.`,
    );
    return;
  }
  if (options.promotion === "if-no-open-prs") {
    const count = openPullRequestCount(repoRoot);
    if (count > 0) {
      console.log(
        `[lastcode:checkpoint] Kept lastcode/main stable because ${count} PR(s) are open.`,
      );
      notify(
        platform,
        "LastCode checkpoint ready",
        `${count} open PR(s) prevented lastcode/main promotion.`,
      );
      return;
    }
  }

  run(repoRoot, "git", [
    "push",
    `--force-with-lease=refs/heads/lastcode/main:${expected}`,
    options.pushRemote,
    `${commit}:refs/heads/lastcode/main`,
  ]);
  console.log(`[lastcode:checkpoint] Promoted ${commit} to ${options.pushRemote}/lastcode/main.`);
}

function main(argv: ReadonlyArray<string>): void {
  const options = parseArgs(argv);
  const hostPlatform = Effect.runSync(HostProcessPlatform);
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  git(repoRoot, ["config", "rerere.enabled", "true"]);
  git(repoRoot, ["config", "rerere.autoupdate", "true"]);

  if (options.fetch) {
    run(repoRoot, "git", ["fetch", options.upstreamRemote, "--prune", "--tags"]);
    run(
      repoRoot,
      "git",
      [
        "fetch",
        options.pushRemote,
        "+refs/tags/lastcode/checkpoint/*:refs/tags/lastcode/checkpoint/*",
      ],
      { allowFailure: true },
    );
    run(repoRoot, "git", [
      "fetch",
      options.pushRemote,
      `+refs/heads/lastcode/main:refs/remotes/${options.pushRemote}/lastcode/main`,
    ]);
  }

  const sourceCommit = git(repoRoot, ["rev-parse", `${options.sourceRef}^{commit}`]);
  const checkpoints = listCheckpointRefs(repoRoot);
  const sourceAncestor = latestCheckpointAncestor(repoRoot, checkpoints, options.sourceRef);
  const sourceNightlyTags = splitLines(
    git(repoRoot, ["tag", "--merged", options.sourceRef, "--list", "v*-nightly.*"]),
  );
  const nightlyTags = splitLines(git(repoRoot, ["tag", "--list", "v*-nightly.*"]));
  const plan = resolveCheckpointPlan({
    checkpointRefs: checkpoints,
    nightlyTags,
    sourceCommit,
    ...(sourceAncestor ? { sourceCheckpointTag: sourceAncestor.checkpointTag } : {}),
    sourceNightlyTags,
    sourceRef: options.sourceRef,
  });

  console.log(`[lastcode:checkpoint] Source: ${plan.candidateRef}`);
  console.log(`[lastcode:checkpoint] Upstream base: ${plan.baseNightly.tag}`);
  if (plan.bootstrapCheckpoint) {
    console.log(
      `[lastcode:checkpoint] ${options.dryRun ? "Would create" : "Creating"} bootstrap checkpoint ${checkpointTagFromNightlyTag(plan.baseNightly.tag)}.`,
    );
  }
  for (const nightly of plan.missingNightlies) {
    console.log(
      `[lastcode:checkpoint] ${options.dryRun ? "Would checkpoint" : "Checkpointing"} ${nightly.tag}.`,
    );
  }
  if (options.dryRun) return;

  let candidateRef = plan.candidateRef;
  let candidateCommit = git(repoRoot, ["rev-parse", `${candidateRef}^{commit}`]);
  if (plan.bootstrapCheckpoint) {
    const checkpointTag = createCheckpointTag(
      repoRoot,
      plan.baseNightly,
      candidateCommit,
      options.sourceRef,
    );
    if (options.pushTags) run(repoRoot, "git", ["push", options.pushRemote, checkpointTag]);
  }

  if (plan.missingNightlies.length === 0) {
    promoteCheckpoint(repoRoot, candidateCommit, options, hostPlatform);
    console.log("[lastcode:checkpoint] No uncheckpointed upstream nightlies remain.");
    return;
  }

  const worktree = resolveAutomationWorktree(repoRoot);
  if (NodeFS.existsSync(worktree)) {
    throw new Error(
      `Nightly sync worktree already exists at ${worktree}. Resolve or remove it first.`,
    );
  }
  NodeFS.mkdirSync(NodePath.dirname(worktree), { recursive: true });
  const firstNightly = plan.missingNightlies[0];
  if (!firstNightly) throw new Error("Missing first nightly checkpoint.");
  let branch = `sync/nightly/${firstNightly.tag}`;
  if (git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true })) {
    throw new Error(`Recovery branch ${branch} already exists.`);
  }

  run(repoRoot, "git", worktreeAddArgs(branch, worktree, candidateRef));
  let completed = false;
  try {
    let baseTag = plan.baseNightly.tag;
    for (const nightly of plan.missingNightlies) {
      const recoveryBranch = `sync/nightly/${nightly.tag}`;
      if (branch !== recoveryBranch) {
        run(worktree, "git", ["branch", "--move", recoveryBranch]);
        branch = recoveryBranch;
      }
      console.log(`[lastcode:checkpoint] Rebasing LastCode from ${baseTag} onto ${nightly.tag}...`);
      run(worktree, "git", ["rebase", "--onto", nightly.tag, baseTag]);
      candidateCommit = git(repoRoot, ["rev-parse", "HEAD"], { cwd: worktree });
      if (options.smoke) runSmokeGate(worktree);
      const checkpointTag = createCheckpointTag(
        repoRoot,
        nightly,
        candidateCommit,
        options.sourceRef,
      );
      if (options.pushTags) run(repoRoot, "git", ["push", options.pushRemote, checkpointTag]);
      baseTag = nightly.tag;
      candidateRef = checkpointTag;
      console.log(`[lastcode:checkpoint] Created ${checkpointTag} at ${candidateCommit}.`);
    }
    completed = true;
  } catch (error) {
    notify(
      hostPlatform,
      "LastCode nightly sync needs attention",
      `${branch} is retained at ${worktree}.`,
    );
    console.error(`[lastcode:checkpoint] Recovery branch ${branch} is retained at ${worktree}.`);
    throw error;
  } finally {
    if (completed) {
      run(repoRoot, "git", ["worktree", "remove", worktree]);
      git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  }

  promoteCheckpoint(repoRoot, candidateCommit, options, hostPlatform);
  notify(hostPlatform, "LastCode nightly checkpoint complete", `${candidateRef} is ready.`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[lastcode:checkpoint] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
