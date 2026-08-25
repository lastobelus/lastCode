#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { appendCheckpointRun, checkpointFailureRecord } from "./lastcode-checkpoint-history.ts";
import {
  checkpointTagFromNightlyTag,
  compareLastCodeInstallableTags,
  compareNightlyTags,
  type LastCodeInstallableTag,
  type NightlyTag,
  nightlyTagFromCheckpointTag,
  parseLastCodeInstallableTag,
  parseNightlyTag,
  revisionTagFromNightlyTag,
  resolveLatestNightlyTag,
  resolveUncheckpointedNightlies,
} from "./lastcode-nightly.ts";

const DEFAULT_SOURCE_REF = "refs/remotes/origin/lastcode/main";
const DEFAULT_UPSTREAM_REMOTE = "upstream";
const DEFAULT_PUSH_REMOTE = "origin";
const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";
const CHECKPOINT_TAG_GLOB = "lastcode/checkpoint/v*-nightly.*";
const REVISION_TAG_GLOB = "lastcode/revision/v*-nightly.*";

export type PromotionMode = "never" | "always" | "if-no-open-prs";

interface CheckpointOptions {
  readonly dryRun: boolean;
  readonly fetch: boolean;
  readonly mirrorUpstreamMain: boolean;
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
  readonly sourceCommit?: string;
}

export interface InstallableRef extends LastCodeInstallableTag {
  readonly commit: string;
  readonly sourceCommit?: string;
}

export type RevisionPlan =
  | { readonly kind: "represented"; readonly installable: InstallableRef }
  | {
      readonly kind: "create";
      readonly installableTag: string;
      readonly nightly: NightlyTag;
      readonly ontoRef: string;
      readonly replayBase?: string;
      readonly revision: number;
    }
  | { readonly kind: "unavailable" };

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
  options: {
    readonly capture?: boolean;
    readonly allowFailure?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...(options.environment ? { env: options.environment } : {}),
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

export function checkpointSmokeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  delete resolved.ELECTRON_RUN_AS_NODE;
  return resolved;
}

export function checkpointSmokeTypecheckCommands(): ReadonlyArray<ReadonlyArray<string>> {
  return [
    ["run", "--filter", "@t3tools/scripts", "typecheck"],
    ["run", "--filter", "@t3tools/client-runtime", "typecheck"],
  ];
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

export function shouldContinueRerereRebase(input: {
  readonly rebaseInProgress: boolean;
  readonly unmergedPaths: ReadonlyArray<string>;
}): boolean {
  return input.rebaseInProgress && input.unmergedPaths.length === 0;
}

export function rerereRebaseMadeProgress(previous: string, current: string): boolean {
  return previous !== current;
}

function rebaseInProgress(worktree: string): boolean {
  const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], { cwd: worktree });
  return ["rebase-merge", "rebase-apply"].some((name) =>
    NodeFS.existsSync(NodePath.join(gitDirectory, name)),
  );
}

function unmergedPaths(worktree: string): ReadonlyArray<string> {
  return splitLines(git(worktree, ["diff", "--name-only", "--diff-filter=U"], { cwd: worktree }));
}

function rebaseProgress(worktree: string): string {
  const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], { cwd: worktree });
  const state = [git(worktree, ["rev-parse", "HEAD"], { cwd: worktree })];
  for (const directory of ["rebase-merge", "rebase-apply"]) {
    for (const name of ["msgnum", "next", "stopped-sha", "git-rebase-todo", "done"]) {
      const path = NodePath.join(gitDirectory, directory, name);
      if (NodeFS.existsSync(path)) {
        state.push(`${directory}/${name}:${NodeFS.readFileSync(path, "utf8")}`);
      }
    }
  }
  return state.join("\0");
}

function rebaseOnto(worktree: string, upstreamTag: string, baseTag: string): void {
  let failure: unknown;
  try {
    run(worktree, "git", ["rebase", "--onto", upstreamTag, baseTag]);
    return;
  } catch (error) {
    failure = error;
  }

  while (
    shouldContinueRerereRebase({
      rebaseInProgress: rebaseInProgress(worktree),
      unmergedPaths: unmergedPaths(worktree),
    })
  ) {
    const previousProgress = rebaseProgress(worktree);
    console.log("[lastcode:checkpoint] Continuing Git's recorded conflict resolution...");
    try {
      run(worktree, "git", ["-c", "core.editor=true", "rebase", "--continue"]);
      return;
    } catch (error) {
      failure = error;
      if (!rerereRebaseMadeProgress(previousProgress, rebaseProgress(worktree))) break;
    }
  }

  throw failure;
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
      const sourceCommit = checkpointSourceCommit(
        git(repoRoot, ["for-each-ref", `refs/tags/${checkpointTag}`, "--format=%(contents)"]),
      );
      return nightly
        ? [
            {
              checkpointTag,
              commit: git(repoRoot, ["rev-list", "-n", "1", checkpointTag]),
              nightly,
              ...(sourceCommit ? { sourceCommit } : {}),
            },
          ]
        : [];
    })
    .toSorted((left, right) => compareNightlyTags(left.nightly, right.nightly));
}

function listInstallableRefs(repoRoot: string): ReadonlyArray<InstallableRef> {
  return splitLines(git(repoRoot, ["tag", "--list", CHECKPOINT_TAG_GLOB, REVISION_TAG_GLOB]))
    .flatMap((tag) => {
      const installable = parseLastCodeInstallableTag(tag);
      if (!installable) return [];
      const sourceCommit = checkpointSourceCommit(
        git(repoRoot, ["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"]),
      );
      return [
        {
          ...installable,
          commit: git(repoRoot, ["rev-list", "-n", "1", tag]),
          ...(sourceCommit ? { sourceCommit } : {}),
        },
      ];
    })
    .toSorted(compareLastCodeInstallableTags);
}

export function resolveRevisionPlan(input: {
  readonly installableRefs: ReadonlyArray<InstallableRef>;
  readonly sourceCommit: string;
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
}): RevisionPlan {
  const installables = input.installableRefs.toSorted(compareLastCodeInstallableTags);
  const represented = installables.findLast(
    (installable) =>
      installable.commit === input.sourceCommit || installable.sourceCommit === input.sourceCommit,
  );
  if (represented) return { kind: "represented", installable: represented };

  const latest = installables.at(-1);
  if (!latest) return { kind: "unavailable" };

  let replayBase: string | undefined;
  if (!input.isAncestor(latest.commit, input.sourceCommit)) {
    if (!latest.sourceCommit || !input.isAncestor(latest.sourceCommit, input.sourceCommit)) {
      throw new Error(
        `Latest installable ${latest.tag} cannot be related to LastCode main ${input.sourceCommit}.`,
      );
    }
    replayBase = latest.sourceCommit;
  }

  const revision =
    Math.max(
      0,
      ...installables
        .filter((installable) => installable.nightly.tag === latest.nightly.tag)
        .map((installable) => installable.revision),
    ) + 1;
  return {
    kind: "create",
    installableTag: revisionTagFromNightlyTag(latest.nightly.tag, revision),
    nightly: latest.nightly,
    ontoRef: latest.tag,
    ...(replayBase ? { replayBase } : {}),
    revision,
  };
}

export function unpublishedCheckpointTags(
  localTags: ReadonlyArray<string>,
  remoteOutput: string,
): ReadonlyArray<string> {
  const published = new Set(
    splitLines(remoteOutput)
      .map((line) => line.split(/\s+/)[1])
      .filter(
        (ref): ref is string =>
          ref !== undefined && ref.startsWith("refs/tags/") && !ref.endsWith("^{}"),
      )
      .map((ref) => ref.slice("refs/tags/".length)),
  );
  return localTags.filter((tag) => !published.has(tag));
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

  const latestCheckpointMatchesSource = latestCheckpoint?.sourceCommit === input.sourceCommit;
  const sourceIsPromotedCheckpoint = sourceCheckpoint?.commit === input.sourceCommit;
  const candidateRef =
    latestCheckpoint &&
    (latestCheckpointMatchesSource ||
      (sourceIsPromotedCheckpoint && sourceCheckpoint.nightly.tag !== latestCheckpoint.nightly.tag))
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

export function checkpointVpPaths(repoRoot: string, worktree: string) {
  return {
    bootstrap: worktreeVp(repoRoot),
    isolated: worktreeVp(worktree),
  };
}

export function checkpointTagPushArgs(
  pushRemote: string,
  checkpointTag: string,
  validation:
    | { readonly kind: "smoke" }
    | {
        readonly candidateCommit: string;
        readonly checkoutHead: string;
        readonly kind: "pre-push";
      },
): ReadonlyArray<string> {
  if (validation.kind === "smoke") {
    return ["push", "--no-verify", pushRemote, checkpointTag];
  }
  if (validation.candidateCommit !== validation.checkoutHead) {
    throw new Error(
      `Refusing to publish ${checkpointTag}: the pre-push hook would validate ${validation.checkoutHead}, not checkpoint commit ${validation.candidateCommit}. Run with checkpoint smoke enabled.`,
    );
  }
  return ["push", pushRemote, checkpointTag];
}

export function promotionNeeded(remoteCommit: string, checkpointCommit: string): boolean {
  return remoteCommit !== checkpointCommit;
}

export function checkpointPromotionPushArgs(
  pushRemote: string,
  remoteCommit: string,
  checkpointCommit: string,
  validation:
    | { readonly kind: "validated" }
    | { readonly checkoutHead: string; readonly kind: "pre-push" },
): ReadonlyArray<string> {
  if (validation.kind === "pre-push" && validation.checkoutHead !== checkpointCommit) {
    throw new Error(
      `Refusing to promote ${checkpointCommit}: the pre-push hook would validate ${validation.checkoutHead}. Run with checkpoint smoke or tag publication enabled.`,
    );
  }
  return [
    "push",
    ...(validation.kind === "validated" ? ["--no-verify"] : []),
    `--force-with-lease=refs/heads/lastcode/main:${remoteCommit}`,
    pushRemote,
    `${checkpointCommit}:refs/heads/lastcode/main`,
  ];
}

export function upstreamMainMirrorPushArgs(
  pushRemote: string,
  remoteCommit: string,
  upstreamCommit: string,
): ReadonlyArray<string> {
  return [
    "push",
    "--no-verify",
    `--force-with-lease=refs/heads/main:${remoteCommit}`,
    pushRemote,
    `${upstreamCommit}:refs/heads/main`,
  ];
}

export function resolveUpstreamMainMirror(
  pushRemote: string,
  remoteCommit: string,
  upstreamCommit: string,
  remoteIsAncestor: boolean,
): ReadonlyArray<string> | undefined {
  if (remoteCommit === upstreamCommit) return undefined;
  if (!remoteIsAncestor) {
    throw new Error(`Refusing to mirror upstream: ${pushRemote}/main has diverged.`);
  }
  return upstreamMainMirrorPushArgs(pushRemote, remoteCommit, upstreamCommit);
}

export function checkpointFailureDisposition(
  pendingCheckpointTag: string | undefined,
  recoveryBranch: string,
  tagDeleted = true,
): { readonly cleanup: boolean; readonly recoveryBranch?: string } {
  return pendingCheckpointTag && tagDeleted
    ? { cleanup: true }
    : { cleanup: false, recoveryBranch };
}

function deleteCheckpointTag(repoRoot: string, checkpointTag: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["tag", "--delete", checkpointTag], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.error) return false;
  return result.status === 0;
}

function pruneUnpublishedInstallableTags(repoRoot: string, pushRemote: string): void {
  for (const tagGlob of [CHECKPOINT_TAG_GLOB, REVISION_TAG_GLOB]) {
    const localTags = splitLines(git(repoRoot, ["tag", "--list", tagGlob]));
    const remoteOutput = git(repoRoot, ["ls-remote", pushRemote, `refs/tags/${tagGlob}`]);
    for (const tag of unpublishedCheckpointTags(localTags, remoteOutput)) {
      if (!deleteCheckpointTag(repoRoot, tag)) {
        throw new Error(`Could not remove unpublished local installable tag ${tag}.`);
      }
    }
  }
}

function parseArgs(argv: ReadonlyArray<string>): CheckpointOptions {
  let dryRun = false;
  let fetch = true;
  let mirrorUpstreamMain = false;
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
    else if (arg === "--mirror-upstream-main") mirrorUpstreamMain = true;
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

  return {
    dryRun,
    fetch,
    mirrorUpstreamMain,
    promotion,
    pushTags,
    smoke,
    sourceRef,
    upstreamRemote,
    pushRemote,
  };
}

export function checkpointMessage(input: {
  readonly upstreamTag: string;
  readonly upstreamCommit: string;
  readonly commit: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly timing: {
    readonly commitsRebased: number;
    readonly durationMs: number;
    readonly finishedAt: string;
    readonly startedAt: string;
  };
}): string {
  return [
    `LastCode checkpoint for ${input.upstreamTag}`,
    "",
    `Upstream-Tag: ${input.upstreamTag}`,
    `Upstream-Commit: ${input.upstreamCommit}`,
    `LastCode-Commit: ${input.commit}`,
    `Source-Ref: ${input.sourceRef}`,
    `Source-Commit: ${input.sourceCommit}`,
    `Fork-Commits-Rebased: ${input.timing.commitsRebased}`,
    `Started-At: ${input.timing.startedAt}`,
    `Finished-At: ${input.timing.finishedAt}`,
    `Duration-Ms: ${input.timing.durationMs}`,
    `Created-At: ${input.timing.finishedAt}`,
  ].join("\n");
}

export function checkpointSourceCommit(message: string): string | undefined {
  return /^Source-Commit:\s*(\S+)\s*$/m.exec(message)?.[1];
}

export function revisionMessage(input: {
  readonly commit: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly upstreamCommit: string;
  readonly upstreamTag: string;
}): string {
  return [
    `LastCode revision ${input.revision} for ${input.upstreamTag}`,
    "",
    `Upstream-Tag: ${input.upstreamTag}`,
    `Upstream-Commit: ${input.upstreamCommit}`,
    `LastCode-Commit: ${input.commit}`,
    `Source-Ref: ${input.sourceRef}`,
    `Source-Commit: ${input.sourceCommit}`,
    `Revision: ${input.revision}`,
    `Created-At: ${input.createdAt}`,
  ].join("\n");
}

function createCheckpointTag(
  repoRoot: string,
  nightly: NightlyTag,
  commit: string,
  sourceRef: string,
  sourceCommit: string,
  timing: {
    readonly commitsRebased: number;
    readonly durationMs: number;
    readonly finishedAt: string;
    readonly startedAt: string;
  },
): string {
  const checkpointTag = checkpointTagFromNightlyTag(nightly.tag);
  git(repoRoot, [
    "tag",
    "--annotate",
    checkpointTag,
    commit,
    "--message",
    checkpointMessage({
      upstreamTag: nightly.tag,
      upstreamCommit: git(repoRoot, ["rev-parse", `${nightly.tag}^{commit}`]),
      commit,
      sourceRef,
      sourceCommit,
      timing,
    }),
  ]);
  return checkpointTag;
}

function createRevisionTag(
  repoRoot: string,
  plan: Extract<RevisionPlan, { kind: "create" }>,
  commit: string,
  sourceRef: string,
  sourceCommit: string,
): string {
  git(repoRoot, [
    "tag",
    "--annotate",
    plan.installableTag,
    commit,
    "--message",
    revisionMessage({
      commit,
      createdAt: new Date().toISOString(),
      revision: plan.revision,
      sourceCommit,
      sourceRef,
      upstreamCommit: git(repoRoot, ["rev-parse", `${plan.nightly.tag}^{commit}`]),
      upstreamTag: plan.nightly.tag,
    }),
  ]);
  return plan.installableTag;
}

function assertForkInvariants(worktree: string): void {
  const requiredText = new Map([
    ["packages/shared/src/desktopDistribution.ts", "codes.lastobelus.lastcode"],
    ["apps/web/src/components/branding/LastCodeWordmark.tsx", "LastCode"],
    ["scripts/lastcode-build-mac.ts", "lastcode/checkpoint/"],
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

function runSmokeGate(repoRoot: string, worktree: string): void {
  const vp = checkpointVpPaths(repoRoot, worktree);
  const environment = checkpointSmokeEnvironment();
  console.log("[lastcode:checkpoint] Installing checkpoint worktree dependencies...");
  run(worktree, vp.bootstrap, ["install", "--frozen-lockfile"], { environment });
  assertForkInvariants(worktree);
  run(
    worktree,
    vp.isolated,
    [
      "test",
      "run",
      "scripts/lastcode-nightly.test.ts",
      "scripts/lastcode-checkpoint.test.ts",
      "scripts/lastcode-local-ci.test.ts",
      "scripts/build-desktop-artifact.test.ts",
      "apps/desktop/src/electron/ElectronProtocol.test.ts",
    ],
    { environment },
  );
  for (const args of checkpointSmokeTypecheckCommands()) {
    run(worktree, vp.isolated, args, { environment });
  }
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

function publishRevisionIfNeeded(
  repoRoot: string,
  sourceRef: string,
  sourceCommit: string,
  installables: ReadonlyArray<InstallableRef>,
  options: CheckpointOptions,
  platform: NodeJS.Platform,
): boolean {
  const plan = resolveRevisionPlan({
    installableRefs: installables,
    sourceCommit,
    isAncestor: (ancestor, descendant) => isAncestor(repoRoot, ancestor, descendant),
  });
  if (plan.kind === "unavailable") return false;
  if (plan.kind === "represented") {
    if (plan.installable.revision === 0) return false;
    promoteCheckpoint(repoRoot, plan.installable.commit, options, platform, options.pushTags);
    console.log(
      `[lastcode:checkpoint] ${plan.installable.tag} already represents current LastCode main.`,
    );
    return true;
  }

  const worktree = resolveAutomationWorktree(repoRoot);
  if (NodeFS.existsSync(worktree)) {
    throw new Error(
      `Nightly sync worktree already exists at ${worktree}. Resolve or remove it first.`,
    );
  }
  NodeFS.mkdirSync(NodePath.dirname(worktree), { recursive: true });
  const branch = `sync/revision/${plan.nightly.tag}.${plan.revision}`;
  if (git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true })) {
    throw new Error(`Recovery branch ${branch} already exists.`);
  }

  run(repoRoot, "git", worktreeAddArgs(branch, worktree, sourceRef));
  let completed = false;
  let pendingTag: string | undefined;
  let candidateCommit = sourceCommit;
  try {
    if (plan.replayBase) {
      console.log(`[lastcode:checkpoint] Replaying new LastCode commits onto ${plan.ontoRef}...`);
      rebaseOnto(worktree, plan.ontoRef, plan.replayBase);
      candidateCommit = git(repoRoot, ["rev-parse", "HEAD"], { cwd: worktree });
    }
    if (options.smoke) runSmokeGate(repoRoot, worktree);
    pendingTag = createRevisionTag(repoRoot, plan, candidateCommit, sourceRef, sourceCommit);
    if (options.pushTags) {
      run(
        repoRoot,
        "git",
        checkpointTagPushArgs(
          options.pushRemote,
          pendingTag,
          options.smoke
            ? { kind: "smoke" }
            : {
                kind: "pre-push",
                candidateCommit,
                checkoutHead: git(repoRoot, ["rev-parse", "HEAD"]),
              },
        ),
      );
    }
    pendingTag = undefined;
    completed = true;
  } catch (error) {
    if (pendingTag) completed = deleteCheckpointTag(repoRoot, pendingTag);
    if (!completed) {
      notify(
        platform,
        "LastCode revision needs attention",
        `${branch} is retained at ${worktree}.`,
      );
      console.error(`[lastcode:checkpoint] Recovery branch ${branch} is retained at ${worktree}.`);
    }
    throw error;
  } finally {
    if (completed) {
      run(repoRoot, "git", ["worktree", "remove", worktree]);
      git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  }

  promoteCheckpoint(
    repoRoot,
    candidateCommit,
    options,
    platform,
    options.smoke || options.pushTags,
  );
  notify(platform, "LastCode revision ready", `${plan.installableTag} is installable.`);
  console.log(`[lastcode:checkpoint] Created ${plan.installableTag} at ${candidateCommit}.`);
  return true;
}

export function openPullRequestListArgs(
  repository: string = LASTCODE_GITHUB_REPOSITORY,
): ReadonlyArray<string> {
  return [
    "pr",
    "list",
    "--repo",
    repository,
    "--base",
    "lastcode/main",
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    "length",
  ];
}

function openPullRequestCount(repoRoot: string): number {
  const value = run(repoRoot, "gh", openPullRequestListArgs(), { capture: true });
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid gh PR count '${value}'.`);
  return count;
}

function promoteCheckpoint(
  repoRoot: string,
  commit: string,
  options: CheckpointOptions,
  platform: NodeJS.Platform,
  validated: boolean,
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

  run(
    repoRoot,
    "git",
    checkpointPromotionPushArgs(
      options.pushRemote,
      expected,
      commit,
      validated
        ? { kind: "validated" }
        : { kind: "pre-push", checkoutHead: git(repoRoot, ["rev-parse", "HEAD"]) },
    ),
  );
  console.log(`[lastcode:checkpoint] Promoted ${commit} to ${options.pushRemote}/lastcode/main.`);
}

function mirrorUpstreamMain(repoRoot: string, options: CheckpointOptions): void {
  const upstreamRef = `refs/remotes/${options.upstreamRemote}/main`;
  const remoteRef = `refs/remotes/${options.pushRemote}/main`;
  const upstreamCommit = git(repoRoot, ["rev-parse", `${upstreamRef}^{commit}`]);
  const remoteCommit = git(repoRoot, ["rev-parse", `${remoteRef}^{commit}`]);
  const pushArgs = resolveUpstreamMainMirror(
    options.pushRemote,
    remoteCommit,
    upstreamCommit,
    isAncestor(repoRoot, remoteCommit, upstreamCommit),
  );
  if (!pushArgs) {
    console.log(`[lastcode:checkpoint] ${options.pushRemote}/main already mirrors ${upstreamRef}.`);
    return;
  }
  if (options.dryRun) {
    console.log(
      `[lastcode:checkpoint] Would fast-forward ${options.pushRemote}/main from ${remoteCommit} to ${upstreamCommit}.`,
    );
    return;
  }
  run(repoRoot, "git", pushArgs);
  console.log(`[lastcode:checkpoint] Mirrored ${upstreamRef} to ${options.pushRemote}/main.`);
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
    run(
      repoRoot,
      "git",
      ["fetch", options.pushRemote, "+refs/tags/lastcode/revision/*:refs/tags/lastcode/revision/*"],
      { allowFailure: true },
    );
    run(repoRoot, "git", [
      "fetch",
      options.pushRemote,
      `+refs/heads/lastcode/main:refs/remotes/${options.pushRemote}/lastcode/main`,
    ]);
    if (options.mirrorUpstreamMain) {
      run(repoRoot, "git", [
        "fetch",
        options.pushRemote,
        `+refs/heads/main:refs/remotes/${options.pushRemote}/main`,
      ]);
    }
  }

  if (options.mirrorUpstreamMain) mirrorUpstreamMain(repoRoot, options);

  if (options.pushTags && !options.dryRun) {
    pruneUnpublishedInstallableTags(repoRoot, options.pushRemote);
  }

  const sourceCommit = git(repoRoot, ["rev-parse", `${options.sourceRef}^{commit}`]);
  const checkpoints = listCheckpointRefs(repoRoot);
  const installables = listInstallableRefs(repoRoot);
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
  if (!plan.bootstrapCheckpoint && plan.missingNightlies.length === 0) {
    const revisionPlan = resolveRevisionPlan({
      installableRefs: installables,
      sourceCommit,
      isAncestor: (ancestor, descendant) => isAncestor(repoRoot, ancestor, descendant),
    });
    if (revisionPlan.kind === "create") {
      console.log(
        `[lastcode:checkpoint] ${options.dryRun ? "Would publish" : "Publishing"} ${revisionPlan.installableTag}.`,
      );
    } else if (revisionPlan.kind === "represented" && revisionPlan.installable.revision > 0) {
      console.log(
        `[lastcode:checkpoint] ${revisionPlan.installable.tag} already represents current LastCode main.`,
      );
    }
  }
  if (options.dryRun) return;

  let candidateRef = plan.candidateRef;
  let candidateCommit = git(repoRoot, ["rev-parse", `${candidateRef}^{commit}`]);
  if (plan.bootstrapCheckpoint) {
    const startedAtMs = Date.now();
    let pendingCheckpointTag: string | undefined;
    const commitsRebased = Number(
      git(repoRoot, ["rev-list", "--count", `${plan.baseNightly.tag}..${candidateCommit}`]),
    );
    try {
      const finishedAtMs = Date.now();
      const timing = {
        commitsRebased,
        durationMs: finishedAtMs - startedAtMs,
        finishedAt: new Date(finishedAtMs).toISOString(),
        startedAt: new Date(startedAtMs).toISOString(),
      };
      const checkpointTag = createCheckpointTag(
        repoRoot,
        plan.baseNightly,
        candidateCommit,
        options.sourceRef,
        sourceCommit,
        timing,
      );
      pendingCheckpointTag = checkpointTag;
      if (options.pushTags) {
        run(
          repoRoot,
          "git",
          checkpointTagPushArgs(options.pushRemote, checkpointTag, {
            kind: "pre-push",
            candidateCommit,
            checkoutHead: git(repoRoot, ["rev-parse", "HEAD"]),
          }),
        );
      }
      pendingCheckpointTag = undefined;
      appendCheckpointRun({
        schemaVersion: 1,
        status: "success",
        upstreamTag: plan.baseNightly.tag,
        ...timing,
        checkpointCommit: candidateCommit,
        checkpointTag,
      });
    } catch (error) {
      const localTagRetained = pendingCheckpointTag
        ? !deleteCheckpointTag(repoRoot, pendingCheckpointTag)
        : false;
      const finishedAtMs = Date.now();
      appendCheckpointRun(
        checkpointFailureRecord(
          {
            commitsRebased,
            error,
            failurePhase: "publication",
            ...(localTagRetained ? { localTagRetained: true } : {}),
            startedAtMs,
            upstreamTag: plan.baseNightly.tag,
          },
          finishedAtMs,
        ),
      );
      throw error;
    }
  }

  if (plan.missingNightlies.length === 0) {
    if (
      !plan.bootstrapCheckpoint &&
      publishRevisionIfNeeded(
        repoRoot,
        options.sourceRef,
        sourceCommit,
        installables,
        options,
        hostPlatform,
      )
    ) {
      console.log("[lastcode:checkpoint] No uncheckpointed upstream nightlies remain.");
      return;
    }
    promoteCheckpoint(repoRoot, candidateCommit, options, hostPlatform, options.pushTags);
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
  let pendingCheckpointTag: string | undefined;
  let attempt:
    | {
        readonly commitsRebased: number;
        readonly nightly: NightlyTag;
        readonly startedAtMs: number;
      }
    | undefined;
  let failurePhase: "publication" | "rebase" | "smoke" | undefined;
  try {
    let baseTag = plan.baseNightly.tag;
    for (const nightly of plan.missingNightlies) {
      const recoveryBranch = `sync/nightly/${nightly.tag}`;
      if (branch !== recoveryBranch) {
        run(worktree, "git", ["branch", "--move", recoveryBranch]);
        branch = recoveryBranch;
      }
      attempt = {
        commitsRebased: Number(
          git(repoRoot, ["rev-list", "--count", `${baseTag}..${candidateRef}^{commit}`]),
        ),
        nightly,
        startedAtMs: Date.now(),
      };
      console.log(`[lastcode:checkpoint] Rebasing LastCode from ${baseTag} onto ${nightly.tag}...`);
      failurePhase = "rebase";
      rebaseOnto(worktree, nightly.tag, baseTag);
      candidateCommit = git(repoRoot, ["rev-parse", "HEAD"], { cwd: worktree });
      failurePhase = "smoke";
      if (options.smoke) runSmokeGate(repoRoot, worktree);
      failurePhase = "publication";
      const finishedAtMs = Date.now();
      const timing = {
        commitsRebased: attempt.commitsRebased,
        durationMs: finishedAtMs - attempt.startedAtMs,
        finishedAt: new Date(finishedAtMs).toISOString(),
        startedAt: new Date(attempt.startedAtMs).toISOString(),
      };
      const checkpointTag = createCheckpointTag(
        repoRoot,
        nightly,
        candidateCommit,
        options.sourceRef,
        sourceCommit,
        timing,
      );
      pendingCheckpointTag = checkpointTag;
      if (options.pushTags) {
        run(
          repoRoot,
          "git",
          checkpointTagPushArgs(
            options.pushRemote,
            checkpointTag,
            options.smoke
              ? { kind: "smoke" }
              : {
                  kind: "pre-push",
                  candidateCommit,
                  checkoutHead: git(repoRoot, ["rev-parse", "HEAD"]),
                },
          ),
        );
      }
      pendingCheckpointTag = undefined;
      appendCheckpointRun({
        schemaVersion: 1,
        status: "success",
        upstreamTag: nightly.tag,
        ...timing,
        checkpointCommit: candidateCommit,
        checkpointTag,
      });
      baseTag = nightly.tag;
      candidateRef = checkpointTag;
      attempt = undefined;
      failurePhase = undefined;
      console.log(`[lastcode:checkpoint] Created ${checkpointTag} at ${candidateCommit}.`);
    }
    completed = true;
  } catch (error) {
    const tagDeleted = pendingCheckpointTag
      ? deleteCheckpointTag(repoRoot, pendingCheckpointTag)
      : true;
    const disposition = checkpointFailureDisposition(pendingCheckpointTag, branch, tagDeleted);
    completed = disposition.cleanup;
    if (attempt) {
      const finishedAtMs = Date.now();
      appendCheckpointRun(
        checkpointFailureRecord(
          {
            commitsRebased: attempt.commitsRebased,
            error,
            ...(failurePhase ? { failurePhase } : {}),
            ...(!tagDeleted ? { localTagRetained: true } : {}),
            ...(disposition.recoveryBranch ? { recoveryBranch: disposition.recoveryBranch } : {}),
            startedAtMs: attempt.startedAtMs,
            upstreamTag: attempt.nightly.tag,
          },
          finishedAtMs,
        ),
      );
    }
    if (disposition.recoveryBranch) {
      notify(
        hostPlatform,
        "LastCode nightly sync needs attention",
        `${branch} is retained at ${worktree}.`,
      );
      console.error(`[lastcode:checkpoint] Recovery branch ${branch} is retained at ${worktree}.`);
    } else {
      notify(
        hostPlatform,
        "LastCode checkpoint publication failed",
        "The temporary worktree was cleaned up; the next run will retry.",
      );
      console.error("[lastcode:checkpoint] Publication failed; the next run will retry.");
    }
    throw error;
  } finally {
    if (completed) {
      run(repoRoot, "git", ["worktree", "remove", worktree]);
      git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`]);
    }
  }

  promoteCheckpoint(
    repoRoot,
    candidateCommit,
    options,
    hostPlatform,
    options.smoke || options.pushTags,
  );
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
