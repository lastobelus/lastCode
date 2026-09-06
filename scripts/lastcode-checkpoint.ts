#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Local Git orchestration intentionally uses host processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { acquirePortableLock } from "./lastcode-lock.mjs";
import {
  immutableSourceFetchRefspec,
  installablePublicationArgs,
  readManifestReplayConfiguration,
  resolveCheckpointReplay,
  sourceObjectRef,
  type CarryBootstrap,
  type CheckpointReplayMode,
  type EffectiveReplayConfiguration,
} from "./lastcode-carry-checkpoint.ts";
import {
  compileCarrySetSameBase,
  completeCarryReplay,
  readCarryReplayPlan,
  replayCarrySetOnto,
  replayUngroupedOnto,
} from "./lastcode-carry-replay.ts";

import {
  appendCheckpointRun,
  checkpointFailureRecord,
  readLatestCheckpointRun,
  type CarrySetShadowRecord,
  type CheckpointRunRecord,
} from "./lastcode-checkpoint-history.ts";
import { runCarrySetShadowCheck, type CarrySetShadowResult } from "./lastcode-carry-set.ts";
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
const CHECKPOINT_TAG_GLOB = "lastcode/checkpoint/v*-nightly.*";
const REVISION_TAG_GLOB = "lastcode/revision/v*-nightly.*";
const CARRY_MANIFEST_PATH = "scripts/lastcode-carry-set.json";
const FINGERPRINT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

export type PromotionMode = "never" | "always";

interface CheckpointOptions {
  readonly dryRun: boolean;
  readonly fetch: boolean;
  readonly mirrorUpstreamMain: boolean;
  readonly promotion: PromotionMode;
  readonly pushTags: boolean;
  readonly smoke: boolean;
  readonly sourceRef: string;
  readonly supersedeFailedRecovery: boolean;
  readonly upstreamRemote: string;
  readonly pushRemote: string;
  readonly selectRecovery?: string;
  readonly recoverySource?: string;
  readonly replayMode?: CheckpointReplayMode;
  readonly rollbackReason?: string;
}

export interface CheckpointRef {
  readonly checkpointTag: string;
  readonly commit: string;
  readonly nightly: NightlyTag;
  readonly sourceCommit?: string;
}

export interface InstallableRef extends LastCodeInstallableTag {
  readonly commit: string;
  readonly sourceCommit?: string;
  readonly replayMode?: CheckpointReplayMode;
  readonly sourceObjectRef?: string;
}

function representedSourceFor(installable: InstallableRef): string {
  const representedSource = installable.sourceObjectRef ?? installable.sourceCommit;
  if (!representedSource) {
    throw new Error(`Carry installable ${installable.tag} does not record its represented source.`);
  }
  return representedSource;
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

export function nextRevisionPlan(
  nightly: NightlyTag,
  installables: ReadonlyArray<InstallableRef>,
): Extract<RevisionPlan, { kind: "create" }> {
  const revision =
    Math.max(
      0,
      ...installables
        .filter((installable) => installable.nightly.tag === nightly.tag)
        .map((installable) => installable.revision),
    ) + 1;
  return {
    kind: "create",
    installableTag: revisionTagFromNightlyTag(nightly.tag, revision),
    nightly,
    ontoRef: checkpointTagFromNightlyTag(nightly.tag),
    revision,
  };
}

export interface CheckpointPlan {
  readonly baseNightly: NightlyTag;
  readonly bootstrapCheckpoint: boolean;
  readonly candidateRef: string;
  readonly missingNightlies: ReadonlyArray<NightlyTag>;
}

export function resolveCarryCheckpointPlan(input: {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  readonly installableRefs: ReadonlyArray<InstallableRef>;
  readonly nightlyTags: ReadonlyArray<string>;
  readonly bootstrapBase: string;
  readonly resolveCommit: (ref: string) => string;
}): CheckpointPlan & { readonly previousCompact?: InstallableRef } {
  const previousCompact = input.installableRefs.findLast(
    (installable) => installable.replayMode === "carry",
  );
  const baseNightly =
    previousCompact?.nightly ??
    input.nightlyTags
      .map(parseNightlyTag)
      .filter((nightly): nightly is NightlyTag => nightly !== undefined)
      .find(
        (nightly) => input.resolveCommit(nightly.tag) === input.resolveCommit(input.bootstrapBase),
      );
  if (!baseNightly) throw new Error("Carry bootstrap base is not an available upstream nightly.");
  const checkpointTags = input.checkpointRefs.map(({ checkpointTag }) => checkpointTag);
  const compactNightlies = new Set(
    input.installableRefs
      .filter((installable) => installable.replayMode === "carry")
      .map((installable) => installable.nightly.tag),
  );
  return {
    baseNightly,
    bootstrapCheckpoint: !checkpointTags.includes(checkpointTagFromNightlyTag(baseNightly.tag)),
    candidateRef: previousCompact?.tag ?? input.bootstrapBase,
    missingNightlies: input.nightlyTags
      .map(parseNightlyTag)
      .filter((nightly): nightly is NightlyTag => nightly !== undefined)
      .filter(
        (nightly) =>
          compareNightlyTags(nightly, baseNightly) > 0 && !compactNightlies.has(nightly.tag),
      )
      .toSorted(compareNightlyTags),
    ...(previousCompact ? { previousCompact } : {}),
  };
}

function run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly capture?: boolean;
    readonly allowFailure?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
    readonly maxBuffer?: number;
  } = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...(options.environment ? { env: options.environment } : {}),
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
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
  return [["run", "-r", "--concurrency-limit", "2", "typecheck"]];
}

export function checkpointSmokeFormatAndLintCommand(): ReadonlyArray<string> {
  return ["check"];
}

function git(
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly cwd?: string;
    readonly maxBuffer?: number;
  } = {},
): string {
  return run(options.cwd ?? repoRoot, "git", args, {
    capture: true,
    ...(options.allowFailure ? { allowFailure: true } : {}),
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
  });
}

function fetchCarryReplayRefs(
  repoRoot: string,
  pushRemote: string,
  bootstrap: CarryBootstrap,
): void {
  run(repoRoot, "git", [
    "fetch",
    pushRemote,
    "refs/lastcode/carry-sources/*:refs/lastcode/carry-sources/*",
  ]);
  if (bootstrap.ref) {
    run(repoRoot, "git", ["fetch", pushRemote, `${bootstrap.ref}:${bootstrap.ref}`]);
  }
}

function assertCarryBootstrapRef(repoRoot: string, bootstrap: CarryBootstrap): void {
  if (!bootstrap.ref) return;
  const actual = git(repoRoot, ["rev-parse", "--verify", `${bootstrap.ref}^{commit}`], {
    allowFailure: true,
  });
  if (!actual) {
    throw new Error(`Carry bootstrap ref ${bootstrap.ref} is unavailable.`);
  }
  if (actual !== bootstrap.head) {
    throw new Error(
      `Carry bootstrap ref ${bootstrap.ref} resolves to ${actual}, expected ${bootstrap.head}.`,
    );
  }
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

function splitNul(value: string): ReadonlyArray<string> {
  return value.split("\0").filter(Boolean);
}

function isAutomationIgnoredPath(path: string): boolean {
  return (
    path === ".DS_Store" ||
    path.endsWith("/.DS_Store") ||
    path === ".agents/skills/babysit" ||
    path.startsWith(".vite-hooks/") ||
    path === "node_modules/" ||
    path.endsWith("/node_modules/") ||
    path.endsWith("/tsconfig.tsbuildinfo") ||
    path === "apps/marketing/.astro/"
  );
}

function unexpectedIgnoredRecoveryPaths(worktree: string): ReadonlyArray<string> {
  return splitNul(
    git(
      worktree,
      ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
      { cwd: worktree },
    ),
  )
    .filter((entry) => entry.startsWith("!! "))
    .map((entry) => entry.slice(3))
    .filter((path) => !isAutomationIgnoredPath(path));
}

function hasInitializedRecoverySubmodules(worktree: string): boolean {
  return Boolean(
    git(worktree, ["submodule", "foreach", "--quiet", "--recursive", "printf x"], {
      cwd: worktree,
    }),
  );
}

function trackedRecoveryPaths(worktree: string): ReadonlyArray<string> {
  return splitNul(git(worktree, ["ls-files", "--cached", "-z"], { cwd: worktree }));
}

export function rebaseStateFiles(worktree: string): ReadonlyArray<string> {
  const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], { cwd: worktree });
  const state: Array<string> = [];
  for (const directory of ["rebase-merge", "rebase-apply"]) {
    const root = NodePath.join(gitDirectory, directory);
    if (!NodeFS.existsSync(root)) continue;
    state.push(`${directory}\0directory\0${(NodeFS.lstatSync(root).mode & 0o7777).toString(8)}`);
    const visit = (path: string, relativePath: string) => {
      for (const entry of NodeFS.readdirSync(path, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        const entryPath = NodePath.join(path, entry.name);
        const entryRelativePath = NodePath.join(relativePath, entry.name);
        const mode = (NodeFS.lstatSync(entryPath).mode & 0o7777).toString(8);
        if (entry.isDirectory()) {
          state.push(`${entryRelativePath}\0directory\0${mode}`);
          visit(entryPath, entryRelativePath);
        } else if (entry.isSymbolicLink()) {
          state.push(`${entryRelativePath}\0symlink\0${mode}\0${NodeFS.readlinkSync(entryPath)}`);
        } else {
          state.push(
            `${entryRelativePath}\0file\0${mode}\0${NodeFS.readFileSync(entryPath).toString("base64")}`,
          );
        }
      }
    };
    visit(root, directory);
  }
  return state;
}

export function checkpointRecoveryFingerprint(worktree: string, recoveryBranch: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const add = (label: string, value: string | Buffer) => {
    hash.update(label);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  };
  add("branch", recoveryBranch);
  add(
    "active-branch",
    git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
      cwd: worktree,
    }),
  );
  for (const ref of ["HEAD", "ORIG_HEAD", "REBASE_HEAD", `refs/heads/${recoveryBranch}`]) {
    add(ref, git(worktree, ["rev-parse", "--verify", ref], { allowFailure: true, cwd: worktree }));
  }
  const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"], { cwd: worktree });
  if (NodeFS.existsSync(NodePath.join(gitDirectory, "locked"))) {
    throw new Error("A locked recovery worktree prevents automatic retirement.");
  }
  const worktreeConfig = NodePath.join(gitDirectory, "config.worktree");
  if (NodeFS.existsSync(worktreeConfig)) {
    const stat = NodeFS.lstatSync(worktreeConfig);
    add("worktree-config-mode", (stat.mode & 0o7777).toString(8));
    add(
      "worktree-config",
      stat.isSymbolicLink()
        ? NodeFS.readlinkSync(worktreeConfig)
        : NodeFS.readFileSync(worktreeConfig),
    );
  } else {
    add("worktree-config", "missing");
  }
  if (hasInitializedRecoverySubmodules(worktree)) {
    throw new Error("Initialized recovery submodules prevent automatic retirement.");
  }
  const hiddenIndexEntry = splitNul(
    git(worktree, ["ls-files", "-v", "-z"], { cwd: worktree }),
  ).find((entry) => entry.startsWith("S ") || /^[a-z] /u.test(entry));
  if (hiddenIndexEntry) {
    throw new Error(
      `Hidden index flag on '${hiddenIndexEntry.slice(2)}' prevents automatic retirement.`,
    );
  }
  add(
    "status",
    git(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: worktree }),
  );
  add(
    "worktree-diff",
    git(worktree, ["diff", "--binary", "--full-index", "--no-ext-diff"], {
      cwd: worktree,
      maxBuffer: FINGERPRINT_DIFF_MAX_BUFFER,
    }),
  );
  add(
    "index-diff",
    git(worktree, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"], {
      cwd: worktree,
      maxBuffer: FINGERPRINT_DIFF_MAX_BUFFER,
    }),
  );
  const trackedPaths = trackedRecoveryPaths(worktree);
  const trackedDirectories = new Set(["."]);
  for (const relativePath of trackedPaths) {
    let directory = NodePath.dirname(relativePath);
    while (directory !== ".") {
      trackedDirectories.add(directory);
      directory = NodePath.dirname(directory);
    }
  }
  for (const relativePath of [...trackedDirectories].sort()) {
    const path = relativePath === "." ? worktree : NodePath.join(worktree, relativePath);
    const stat = NodeFS.lstatSync(path);
    add(
      `tracked-directory:${relativePath}`,
      `${stat.isDirectory() ? "directory" : "other"}\0${(stat.mode & 0o7777).toString(8)}`,
    );
  }
  for (const relativePath of trackedPaths) {
    const path = NodePath.join(worktree, relativePath);
    try {
      const stat = NodeFS.lstatSync(path);
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
      if (stat.isDirectory() && NodeFS.readdirSync(path).length > 0) {
        throw new Error(
          `Nonempty deinitialized gitlink '${relativePath}' prevents automatic retirement.`,
        );
      }
      add(`tracked-mode:${relativePath}`, `${kind}\0${(stat.mode & 0o7777).toString(8)}`);
      let content: string | Buffer = "";
      if (stat.isSymbolicLink()) content = NodeFS.readlinkSync(path);
      else if (!stat.isDirectory()) content = NodeFS.readFileSync(path);
      add(`tracked-content:${relativePath}`, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        add(`tracked-mode:${relativePath}`, "missing");
        continue;
      }
      throw error;
    }
  }
  const untrackedPaths = splitLines(
    git(worktree, ["ls-files", "--others", "--exclude-standard"], { cwd: worktree }),
  );
  if (untrackedPaths.length > 0) {
    throw new Error(
      `Untracked recovery path '${untrackedPaths[0]}' prevents automatic retirement.`,
    );
  }
  const unexpectedIgnoredPath = unexpectedIgnoredRecoveryPaths(worktree)[0];
  if (unexpectedIgnoredPath) {
    throw new Error(
      `Ignored recovery path '${unexpectedIgnoredPath}' prevents automatic retirement.`,
    );
  }
  for (const state of rebaseStateFiles(worktree)) add("rebase-state", state);
  return hash.digest("hex");
}

export function supersededRecoveryNightly(input: {
  readonly latestNightly: NightlyTag | undefined;
  readonly recoveryFingerprint: string | undefined;
  readonly recoveryWorktreeExists: boolean;
  readonly run: CheckpointRunRecord | undefined;
}): NightlyTag | undefined {
  const failedNightly = input.run ? parseNightlyTag(input.run.upstreamTag) : undefined;
  if (
    input.run?.status !== "failed" ||
    (input.run.failurePhase !== "rebase" && input.run.failurePhase !== "smoke") ||
    !input.run.recoveryBranch ||
    input.run.recoveryBranch !== `sync/nightly/${input.run.upstreamTag}` ||
    !input.run.recoveryFingerprint ||
    input.run.recoveryFingerprint !== input.recoveryFingerprint ||
    !input.recoveryWorktreeExists ||
    !failedNightly ||
    !input.latestNightly ||
    compareNightlyTags(input.latestNightly, failedNightly) <= 0
  ) {
    return undefined;
  }
  return failedNightly;
}

export function recoverySupersessionMode(input: {
  readonly dryRun: boolean;
  readonly enabled: boolean;
}): "disabled" | "preview" | "retire" {
  if (!input.enabled) return "disabled";
  return input.dryRun ? "preview" : "retire";
}

function retireSupersededRecovery(
  repoRoot: string,
  worktree: string,
  runRecord: CheckpointRunRecord,
): void {
  const recoveryBranch = runRecord.recoveryBranch;
  const expectedFingerprint = runRecord.recoveryFingerprint;
  if (!recoveryBranch || !expectedFingerprint) {
    throw new Error("Superseded recovery is missing its guarded cleanup metadata.");
  }
  const branchRef = `refs/heads/${recoveryBranch}`;
  const branchCommit = git(repoRoot, ["rev-parse", "--verify", branchRef]);
  if (checkpointRecoveryFingerprint(worktree, recoveryBranch) !== expectedFingerprint) {
    throw new Error(`Recovery ${recoveryBranch} changed while supersession was being verified.`);
  }
  if (rebaseInProgress(worktree)) run(worktree, "git", ["rebase", "--abort"]);
  const branch = git(worktree, ["branch", "--show-current"], { cwd: worktree });
  if (branch !== recoveryBranch) {
    throw new Error(`Recovery worktree changed branches before cleanup; found '${branch}'.`);
  }
  if (git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktree })) {
    throw new Error(`Recovery ${recoveryBranch} is not clean after aborting its failed rebase.`);
  }
  run(repoRoot, "git", ["worktree", "remove", worktree]);
  run(repoRoot, "git", ["update-ref", "-d", branchRef, branchCommit]);
}

function supersedeFailedRecovery(
  repoRoot: string,
  nightlyTags: ReadonlyArray<string>,
  mode: "disabled" | "preview" | "retire",
): NightlyTag | undefined {
  if (mode === "disabled") return undefined;
  const runRecord = readLatestCheckpointRun();
  if (!runRecord?.recoveryBranch || !runRecord.recoveryFingerprint) return undefined;
  const worktree = resolveAutomationWorktree(repoRoot);
  const recoveryWorktreeExists = NodeFS.existsSync(worktree);
  const latestNightly = resolveLatestNightlyTag(nightlyTags);
  const failedNightly = supersededRecoveryNightly({
    latestNightly,
    recoveryFingerprint: recoveryWorktreeExists
      ? checkpointRecoveryFingerprint(worktree, runRecord.recoveryBranch)
      : undefined,
    recoveryWorktreeExists,
    run: runRecord,
  });
  if (!failedNightly || !latestNightly) return undefined;
  if (mode === "retire") {
    retireSupersededRecovery(repoRoot, worktree, runRecord);
    console.log(
      `[lastcode:checkpoint] Retired untouched recovery ${runRecord.recoveryBranch}; ${latestNightly.tag} supersedes ${failedNightly.tag}.`,
    );
  } else {
    console.log(
      `[lastcode:checkpoint] Dry run would retire untouched recovery ${runRecord.recoveryBranch}; ${latestNightly.tag} supersedes ${failedNightly.tag}.`,
    );
  }
  return failedNightly;
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
      const contents = git(repoRoot, ["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"]);
      const sourceCommit = checkpointSourceCommit(contents);
      const replayMode = checkpointReplayMode(contents);
      const canonicalSourceRef = checkpointTrailer(contents, "Source-Object-Ref");
      if (
        canonicalSourceRef &&
        sourceCommit &&
        git(repoRoot, ["rev-parse", "--verify", `${canonicalSourceRef}^{commit}`], {
          allowFailure: true,
        }) !== sourceCommit
      ) {
        throw new Error(
          `Installable ${tag} does not retain Source-Commit ${sourceCommit} at ${canonicalSourceRef}.`,
        );
      }
      return [
        {
          ...installable,
          commit: git(repoRoot, ["rev-list", "-n", "1", tag]),
          ...(sourceCommit ? { sourceCommit } : {}),
          ...(replayMode ? { replayMode } : {}),
          ...(canonicalSourceRef ? { sourceObjectRef: canonicalSourceRef } : {}),
        },
      ];
    })
    .toSorted(compareLastCodeInstallableTags);
}

export function validateHistoricalBootstrapSource(input: {
  readonly bootstrap: CarryBootstrap;
  readonly installables: ReadonlyArray<InstallableRef>;
  readonly repoRoot: string;
}): string | undefined {
  const { representedSource, sourceTag } = input.bootstrap;
  if (!representedSource || !sourceTag) return undefined;
  const installable = input.installables.find(({ tag }) => tag === sourceTag);
  if (!installable) {
    throw new Error(`Carry bootstrap source tag ${sourceTag} is not an available installable.`);
  }
  if (
    git(input.repoRoot, ["cat-file", "-t", `refs/tags/${sourceTag}`], { allowFailure: true }) !==
    "tag"
  ) {
    throw new Error(`Carry bootstrap source tag ${sourceTag} must be annotated.`);
  }
  if (installable.commit !== input.bootstrap.source) {
    throw new Error(
      `Carry bootstrap source tag ${sourceTag} resolves to ${installable.commit}, expected ${input.bootstrap.source}.`,
    );
  }
  const message = git(input.repoRoot, [
    "for-each-ref",
    `refs/tags/${sourceTag}`,
    "--format=%(contents)",
  ]);
  const recordedSource = checkpointTrailer(message, "Source-Commit");
  if (recordedSource !== representedSource) {
    throw new Error(
      `Carry bootstrap source tag ${sourceTag} records Source-Commit ${recordedSource ?? "missing"}, expected ${representedSource}.`,
    );
  }
  const recordedUpstream = checkpointTrailer(message, "Upstream-Commit");
  if (recordedUpstream !== input.bootstrap.base) {
    throw new Error(
      `Carry bootstrap source tag ${sourceTag} records Upstream-Commit ${recordedUpstream ?? "missing"}, expected ${input.bootstrap.base}.`,
    );
  }
  return representedSource;
}

export function resolveRevisionPlan(input: {
  readonly installableRefs: ReadonlyArray<InstallableRef>;
  readonly sourceCommit: string;
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
  readonly replayMode?: CheckpointReplayMode;
}): RevisionPlan {
  const installables = input.installableRefs.toSorted(compareLastCodeInstallableTags);
  const represented = installables.findLast(
    (installable) =>
      installable.commit === input.sourceCommit || installable.sourceCommit === input.sourceCommit,
  );
  if (represented) {
    if (input.replayMode === "historical" && represented.replayMode === "carry") {
      const replacement = nextRevisionPlan(represented.nightly, installables);
      return {
        ...replacement,
        ontoRef: represented.tag,
        replayBase: represented.sourceCommit ?? represented.commit,
      };
    }
    return { kind: "represented", installable: represented };
  }

  const latest = installables.at(-1);
  if (!latest) return { kind: "unavailable" };

  let replayBase: string | undefined;
  if (!input.isAncestor(latest.commit, input.sourceCommit)) {
    const related = installables.findLast((installable) => {
      if (input.isAncestor(installable.commit, input.sourceCommit)) return true;
      return (
        installable.sourceCommit !== undefined &&
        input.isAncestor(installable.sourceCommit, input.sourceCommit)
      );
    });
    if (!related) {
      throw new Error(
        `Latest installable ${latest.tag} cannot be related to LastCode main ${input.sourceCommit}.`,
      );
    }
    replayBase = input.isAncestor(related.commit, input.sourceCommit)
      ? related.commit
      : related.sourceCommit;
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
  readonly supersedeThroughNightlyTag?: string;
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
  const candidateRef =
    latestCheckpoint && latestCheckpointMatchesSource
      ? latestCheckpoint.checkpointTag
      : input.sourceRef;
  const candidateBase = candidateRef === input.sourceRef ? sourceBase : latestCheckpoint?.nightly;
  if (!candidateBase) throw new Error("Could not resolve the LastCode checkpoint base.");

  const checkpointTags = input.checkpointRefs.map(({ checkpointTag }) => checkpointTag);
  const supersedeThrough = input.supersedeThroughNightlyTag
    ? parseNightlyTag(input.supersedeThroughNightlyTag)
    : undefined;
  const missingNightlies = resolveUncheckpointedNightlies(input.nightlyTags, checkpointTags).filter(
    (nightly) =>
      compareNightlyTags(nightly, candidateBase) > 0 &&
      (!supersedeThrough || compareNightlyTags(nightly, supersedeThrough) > 0),
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

function immutableRemoteSourceCommit(
  repoRoot: string,
  remote: string,
  installableTag: string,
  sourceCommit: string,
): string | undefined {
  const ref = sourceObjectRef(installableTag);
  const remoteCommit = splitLines(git(repoRoot, ["ls-remote", remote, ref]))[0]?.split(/\s+/)[0];
  if (remoteCommit && remoteCommit !== sourceCommit) {
    throw new Error(
      `Immutable source ref ${ref} already names ${remoteCommit}, expected ${sourceCommit}.`,
    );
  }
  return remoteCommit;
}

function installableTagPushArgs(
  repoRoot: string,
  remote: string,
  installableTag: string,
  sourceCommit: string,
  validation:
    | { readonly kind: "smoke" }
    | {
        readonly candidateCommit: string;
        readonly checkoutHead: string;
        readonly kind: "pre-push";
      },
): ReadonlyArray<string> {
  const tagArgs = checkpointTagPushArgs(remote, installableTag, validation);
  return installablePublicationArgs({
    remote,
    installableTag,
    sourceCommit,
    noVerify: tagArgs.includes("--no-verify"),
    ...(immutableRemoteSourceCommit(repoRoot, remote, installableTag, sourceCommit)
      ? { expectedRemoteSource: sourceCommit }
      : {}),
  });
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
  preserveRecovery = false,
): { readonly cleanup: boolean; readonly recoveryBranch?: string } {
  return pendingCheckpointTag && tagDeleted && !preserveRecovery
    ? { cleanup: true }
    : { cleanup: false, recoveryBranch };
}

export function carryBootstrapFailureDisposition(input: {
  readonly failurePhase: "publication" | "smoke";
  readonly pendingCheckpointTag?: string;
  readonly recoveryBranch?: string;
  readonly tagDeleted: boolean;
}): { readonly cleanup: boolean; readonly recoveryBranch?: string } {
  if (!input.recoveryBranch) return { cleanup: false };
  return checkpointFailureDisposition(
    input.pendingCheckpointTag,
    input.recoveryBranch,
    input.tagDeleted,
    input.failurePhase !== "publication",
  );
}

function deleteCheckpointTag(repoRoot: string, checkpointTag: string): boolean {
  const result = NodeChildProcess.spawnSync("git", ["tag", "--delete", checkpointTag], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.error) return false;
  if (result.status !== 0) return false;
  const sourceRef = sourceObjectRef(checkpointTag);
  const sourceCommit = git(repoRoot, ["rev-parse", "--verify", sourceRef], {
    allowFailure: true,
  });
  if (sourceCommit) git(repoRoot, ["update-ref", "-d", sourceRef, sourceCommit]);
  return true;
}

function ensureLocalSourceObjectRef(
  repoRoot: string,
  installableTag: string,
  sourceCommit: string,
): boolean {
  const ref = sourceObjectRef(installableTag);
  const existing = git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
  });
  if (existing && existing !== sourceCommit) {
    throw new Error(
      `Immutable source ref ${ref} already names ${existing}, expected ${sourceCommit}.`,
    );
  }
  if (existing) return false;
  git(repoRoot, ["update-ref", ref, sourceCommit, "0000000000000000000000000000000000000000"]);
  return true;
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
  let supersedeFailedRecovery = false;
  let upstreamRemote = DEFAULT_UPSTREAM_REMOTE;
  let pushRemote = DEFAULT_PUSH_REMOTE;
  let selectRecovery: string | undefined;
  let recoverySource: string | undefined;
  let replayMode: CheckpointReplayMode | undefined;
  let rollbackReason: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-fetch") fetch = false;
    else if (arg === "--mirror-upstream-main") mirrorUpstreamMain = true;
    else if (arg === "--no-smoke") smoke = false;
    else if (arg === "--push-tags") pushTags = true;
    else if (arg === "--supersede-failed-recovery") supersedeFailedRecovery = true;
    else if (arg === "--promote") promotion = "always";
    else if (
      arg === "--source-ref" ||
      arg === "--upstream-remote" ||
      arg === "--push-remote" ||
      arg === "--select-recovery" ||
      arg === "--recovery-source" ||
      arg === "--replay-mode" ||
      arg === "--rollback-reason"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--source-ref") sourceRef = value;
      else if (arg === "--upstream-remote") upstreamRemote = value;
      else if (arg === "--push-remote") pushRemote = value;
      else if (arg === "--select-recovery") selectRecovery = value;
      else if (arg === "--recovery-source") recoverySource = value;
      else if (arg === "--replay-mode") {
        if (value !== "carry" && value !== "historical") {
          throw new Error("--replay-mode must be 'carry' or 'historical'.");
        }
        replayMode = value;
      } else rollbackReason = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (Boolean(selectRecovery) !== Boolean(recoverySource)) {
    throw new Error("--select-recovery and --recovery-source must be supplied together.");
  }
  return {
    dryRun,
    fetch,
    mirrorUpstreamMain,
    promotion,
    pushTags,
    smoke,
    sourceRef,
    supersedeFailedRecovery,
    upstreamRemote,
    pushRemote,
    ...(selectRecovery ? { selectRecovery } : {}),
    ...(recoverySource ? { recoverySource } : {}),
    ...(replayMode ? { replayMode } : {}),
    ...(rollbackReason ? { rollbackReason } : {}),
  };
}

export function checkpointMessage(input: {
  readonly upstreamTag: string;
  readonly upstreamCommit: string;
  readonly commit: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly replay: EffectiveReplayConfiguration;
  readonly sourceObjectRef: string;
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
    `Source-Object-Ref: ${input.sourceObjectRef}`,
    `Replay-Mode: ${input.replay.mode}`,
    ...(input.replay.rollbackReason ? [`Rollback-Reason: ${input.replay.rollbackReason}`] : []),
    `Fork-Commits-Rebased: ${input.timing.commitsRebased}`,
    `Started-At: ${input.timing.startedAt}`,
    `Finished-At: ${input.timing.finishedAt}`,
    `Duration-Ms: ${input.timing.durationMs}`,
    `Created-At: ${input.timing.finishedAt}`,
  ].join("\n");
}

export function checkpointSourceCommit(message: string): string | undefined {
  return checkpointTrailer(message, "Source-Commit");
}

export function checkpointTrailer(message: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}:\\s*(\\S(?:.*\\S)?)\\s*$`, "m").exec(message)?.[1];
}

export function checkpointReplayMode(message: string): CheckpointReplayMode | undefined {
  const mode = checkpointTrailer(message, "Replay-Mode");
  return mode === "carry" || mode === "historical" ? mode : undefined;
}

export function revisionMessage(input: {
  readonly commit: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly upstreamCommit: string;
  readonly upstreamTag: string;
  readonly replay: EffectiveReplayConfiguration;
  readonly sourceObjectRef: string;
}): string {
  return [
    `LastCode revision ${input.revision} for ${input.upstreamTag}`,
    "",
    `Upstream-Tag: ${input.upstreamTag}`,
    `Upstream-Commit: ${input.upstreamCommit}`,
    `LastCode-Commit: ${input.commit}`,
    `Source-Ref: ${input.sourceRef}`,
    `Source-Commit: ${input.sourceCommit}`,
    `Source-Object-Ref: ${input.sourceObjectRef}`,
    `Replay-Mode: ${input.replay.mode}`,
    ...(input.replay.rollbackReason ? [`Rollback-Reason: ${input.replay.rollbackReason}`] : []),
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
  replay: EffectiveReplayConfiguration,
  timing: {
    readonly commitsRebased: number;
    readonly durationMs: number;
    readonly finishedAt: string;
    readonly startedAt: string;
  },
): string {
  const checkpointTag = checkpointTagFromNightlyTag(nightly.tag);
  const canonicalSourceRef = sourceObjectRef(checkpointTag);
  const sourceRefCreated = ensureLocalSourceObjectRef(repoRoot, checkpointTag, sourceCommit);
  try {
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
        replay,
        sourceObjectRef: canonicalSourceRef,
        timing,
      }),
    ]);
  } catch (error) {
    if (sourceRefCreated) git(repoRoot, ["update-ref", "-d", canonicalSourceRef, sourceCommit]);
    throw error;
  }
  return checkpointTag;
}

function createRevisionTag(
  repoRoot: string,
  plan: Extract<RevisionPlan, { kind: "create" }>,
  commit: string,
  sourceRef: string,
  sourceCommit: string,
  replay: EffectiveReplayConfiguration,
): string {
  const canonicalSourceRef = sourceObjectRef(plan.installableTag);
  const sourceRefCreated = ensureLocalSourceObjectRef(repoRoot, plan.installableTag, sourceCommit);
  try {
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
        replay,
        sourceObjectRef: canonicalSourceRef,
        sourceRef,
        upstreamCommit: git(repoRoot, ["rev-parse", `${plan.nightly.tag}^{commit}`]),
        upstreamTag: plan.nightly.tag,
      }),
    ]);
  } catch (error) {
    if (sourceRefCreated) git(repoRoot, ["update-ref", "-d", canonicalSourceRef, sourceCommit]);
    throw error;
  }
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
  run(worktree, vp.isolated, checkpointSmokeFormatAndLintCommand(), { environment });
  run(
    worktree,
    vp.isolated,
    [
      "test",
      "run",
      "scripts/lastcode-carry-checkpoint.test.ts",
      "scripts/lastcode-carry-replay.test.ts",
      "scripts/lastcode-nightly.test.ts",
      "scripts/lastcode-checkpoint.test.ts",
      "scripts/lastcode-local-ci.test.ts",
      "scripts/build-desktop-artifact.test.ts",
      "apps/desktop/src/electron/ElectronProtocol.test.ts",
      "apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts",
      "apps/server/src/persistence/Migrations/054_ProjectionThreadsUnsettledAt.test.ts",
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

export function runPromotionThenShadow(promote: () => void, shadow: () => void): void {
  try {
    promote();
  } finally {
    shadow();
  }
}

function publishRevisionIfNeeded(
  repoRoot: string,
  sourceRef: string,
  sourceCommit: string,
  installables: ReadonlyArray<InstallableRef>,
  options: CheckpointOptions,
  platform: NodeJS.Platform,
  replay: EffectiveReplayConfiguration,
): { readonly handled: boolean } {
  const plan = resolveRevisionPlan({
    installableRefs: installables,
    sourceCommit,
    isAncestor: (ancestor, descendant) => isAncestor(repoRoot, ancestor, descendant),
    replayMode: replay.mode,
  });
  if (plan.kind === "unavailable") return { handled: false };
  if (plan.kind === "represented") {
    promoteCheckpoint(repoRoot, plan.installable.commit, options, sourceCommit, options.pushTags);
    console.log(
      `[lastcode:checkpoint] ${plan.installable.tag} already represents current LastCode main.`,
    );
    return { handled: true };
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

  run(repoRoot, "git", worktreeAddArgs(branch, worktree, sourceCommit));
  let completed = false;
  let pendingTag: string | undefined;
  let candidateCommit = sourceCommit;
  const startedAtMs = Date.now();
  let failurePhase: "publication" | "rebase" | "smoke" = "rebase";
  try {
    if (plan.replayBase) {
      console.log(`[lastcode:checkpoint] Replaying new LastCode commits onto ${plan.ontoRef}...`);
      const representedCompact =
        replay.mode === "historical" && replay.configuredMode === "carry"
          ? installables.findLast((installable) => installable.replayMode === "carry")
          : undefined;
      if (representedCompact) {
        replayUngroupedOnto({
          repo: repoRoot,
          worktree,
          sourceBase: representedCompact.nightly.tag,
          currentSource: sourceCommit,
          onto: representedCompact.nightly.tag,
          representedCompactHead: representedCompact.commit,
          representedSource: representedSourceFor(representedCompact),
        });
      } else {
        rebaseOnto(worktree, plan.ontoRef, plan.replayBase);
      }
      candidateCommit = git(repoRoot, ["rev-parse", "HEAD"], { cwd: worktree });
    }
    failurePhase = "smoke";
    if (options.smoke) runSmokeGate(repoRoot, worktree);
    if (
      git(worktree, ["rev-parse", "HEAD"]) !== candidateCommit ||
      git(worktree, ["status", "--porcelain", "--untracked-files=all"])
    ) {
      throw new Error("Revision changed during validation; retain and inspect the worktree.");
    }
    failurePhase = "publication";
    pendingTag = createRevisionTag(
      repoRoot,
      plan,
      candidateCommit,
      sourceRef,
      sourceCommit,
      replay,
    );
    if (options.pushTags) {
      run(
        repoRoot,
        "git",
        installableTagPushArgs(
          repoRoot,
          options.pushRemote,
          pendingTag,
          sourceCommit,
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
    const publishedTag = pendingTag;
    pendingTag = undefined;
    completed = true;
    const finishedAtMs = Date.now();
    appendCheckpointRun({
      schemaVersion: 1,
      status: "success",
      upstreamTag: plan.nightly.tag,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      commitsRebased: 0,
      checkpointCommit: candidateCommit,
      checkpointTag: publishedTag,
      replayMode: replay.mode,
      ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
      sourceObjectRef: sourceObjectRef(publishedTag),
      sourceCommit,
    });
  } catch (error) {
    if (pendingTag) completed = deleteCheckpointTag(repoRoot, pendingTag);
    appendCheckpointRun(
      checkpointFailureRecord({
        commitsRebased: 0,
        error,
        failurePhase,
        ...(!completed ? { recoveryBranch: branch } : {}),
        replayMode: replay.mode,
        ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
        sourceCommit,
        startedAtMs,
        upstreamTag: plan.nightly.tag,
      }),
    );
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

  runPromotionThenShadow(
    () =>
      promoteCheckpoint(
        repoRoot,
        candidateCommit,
        options,
        sourceCommit,
        options.smoke || options.pushTags,
      ),
    () => runHistoricalShadowIfNeeded(repoRoot, plan.installableTag, replay),
  );
  notify(platform, "LastCode revision ready", `${plan.installableTag} is installable.`);
  console.log(`[lastcode:checkpoint] Created ${plan.installableTag} at ${candidateCommit}.`);
  return { handled: true };
}

function promoteCheckpoint(
  repoRoot: string,
  commit: string,
  options: CheckpointOptions,
  sourceCommit: string,
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
  if (expected !== sourceCommit) {
    throw new Error(
      `LastCode main changed from candidate source ${sourceCommit} to ${expected}; refusing stale promotion. Retry to incorporate the current main.`,
    );
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

export function runCarrySetShadowAfterPublication(
  repoRoot: string,
  checkpointTag: string | undefined,
  dependencies: {
    readonly append: (record: CarrySetShadowRecord) => boolean;
    readonly check: (repoRoot: string, checkpointTag: string) => CarrySetShadowResult;
    readonly error: (message: string) => void;
    readonly log: (message: string) => void;
    readonly now: () => number;
  } = {
    append: (record) => appendCheckpointRun(record),
    check: runCarrySetShadowCheck,
    error: (message) => console.error(message),
    log: (message) => console.log(message),
    now: Date.now,
  },
): CarrySetShadowRecord | undefined {
  if (!checkpointTag) return undefined;
  const startedAtMs = dependencies.now();
  try {
    const result = dependencies.check(repoRoot, checkpointTag);
    const finishedAtMs = dependencies.now();
    const record: CarrySetShadowRecord = {
      schemaVersion: 1,
      status: "shadow",
      outcome: "success",
      checkpointTag,
      baseCommit: result.baseCommit,
      sourceCommit: result.sourceCommit,
      tree: result.tree,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
    };
    dependencies.append(record);
    dependencies.log(`[lastcode:checkpoint] Carry-set shadow check passed for ${checkpointTag}.`);
    return record;
  } catch (error) {
    const finishedAtMs = dependencies.now();
    const message = error instanceof Error ? error.message : String(error);
    const record: CarrySetShadowRecord = {
      schemaVersion: 1,
      status: "shadow",
      outcome: "failed",
      checkpointTag,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      error: message,
    };
    dependencies.append(record);
    dependencies.error(
      `[lastcode:checkpoint] Carry-set shadow check failed for ${checkpointTag}: ${message}`,
    );
    return record;
  }
}

function runHistoricalShadowIfNeeded(
  repoRoot: string,
  checkpointTag: string | undefined,
  replay: EffectiveReplayConfiguration,
): void {
  if (replay.mode === "historical") runCarrySetShadowAfterPublication(repoRoot, checkpointTag);
}

export interface RecoverySelection {
  readonly head: string;
  readonly sourceCommit: string;
  readonly nightlyTag: string;
  readonly replayMode?: CheckpointReplayMode;
  readonly rollbackReason?: string;
}

export function carryRecoveryBranch(nightlyTag: string): string {
  if (!parseNightlyTag(nightlyTag))
    throw new Error("Carry recovery requires an exact nightly tag.");
  return `sync/nightly/${nightlyTag}`;
}

export function publishedRecoveryInstallable(
  installables: ReadonlyArray<InstallableRef>,
  selection: RecoverySelection,
): InstallableRef | undefined {
  return installables.find(
    (installable) =>
      installable.nightly.tag === selection.nightlyTag &&
      installable.commit === selection.head &&
      installable.sourceCommit === selection.sourceCommit,
  );
}

export function carryCompilationNeeded(input: {
  readonly mode: CheckpointReplayMode;
  readonly previousCompact?: InstallableRef;
  readonly selection?: RecoverySelection;
  readonly sourceCommit: string;
}): boolean {
  return (
    input.mode === "carry" &&
    !input.selection &&
    (!input.previousCompact ||
      (input.previousCompact.commit !== input.sourceCommit &&
        input.previousCompact.sourceCommit !== input.sourceCommit))
  );
}

export function unexpectedHistoricalCheckpointChanges(input: {
  readonly repoRoot: string;
  readonly historicalCommit: string;
  readonly candidateCommit: string;
  readonly representedSource: string;
  readonly currentSource: string;
}): ReadonlyArray<string> {
  if (!isAncestor(input.repoRoot, input.representedSource, input.currentSource)) {
    throw new Error(
      "Historical checkpoint source is not an ancestor of current LastCode main; its preserved resolution paths cannot be verified.",
    );
  }
  const expectedTree = git(input.repoRoot, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    `--merge-base=${input.representedSource}`,
    input.historicalCommit,
    input.currentSource,
  ]);
  return splitNul(
    git(input.repoRoot, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      expectedTree,
      input.candidateCommit,
    ]),
  );
}

export function recoveryPublicationArgs(
  remote: string,
  tag: string,
  selection: RecoverySelection,
  expectedRemoteSource?: string,
): ReadonlyArray<string> {
  return [
    "push",
    "--no-verify",
    "--atomic",
    `--force-with-lease=refs/heads/lastcode/main:${selection.sourceCommit}`,
    `--force-with-lease=${sourceObjectRef(tag)}:${expectedRemoteSource ?? "0000000000000000000000000000000000000000"}`,
    remote,
    tag,
    `${selection.sourceCommit}:${sourceObjectRef(tag)}`,
    `${selection.head}:refs/heads/lastcode/main`,
  ];
}

function releasePublishedRecovery(
  repoRoot: string,
  worktree: string,
  selectionPath: string,
  selection: RecoverySelection,
): void {
  if (NodeFS.existsSync(worktree)) {
    assertRecoverySelection(worktree, selection, selection.sourceCommit);
    run(repoRoot, "git", ["worktree", "remove", worktree]);
  }
  const branchRef = `refs/heads/sync/nightly/${selection.nightlyTag}`;
  const branchHead = git(repoRoot, ["rev-parse", "--verify", branchRef], { allowFailure: true });
  if (branchHead) git(repoRoot, ["update-ref", "-d", branchRef, selection.head]);
  NodeFS.unlinkSync(selectionPath);
}

export function parseRecoverySelection(value: unknown): RecoverySelection {
  if (value === null || typeof value !== "object") throw new Error("Invalid recovery selection.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.head !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.head) ||
    typeof input.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    typeof input.nightlyTag !== "string" ||
    !parseNightlyTag(input.nightlyTag)
  ) {
    throw new Error("Recovery selection requires full commits and an exact nightly tag.");
  }
  if (
    input.replayMode !== undefined &&
    input.replayMode !== "carry" &&
    input.replayMode !== "historical"
  ) {
    throw new Error("Recovery selection has an invalid replay mode.");
  }
  if (
    input.rollbackReason !== undefined &&
    (typeof input.rollbackReason !== "string" || input.rollbackReason.trim() === "")
  ) {
    throw new Error("Recovery selection has an invalid rollback reason.");
  }
  if (input.rollbackReason !== undefined && input.replayMode !== "historical") {
    throw new Error("Recovery rollback reason requires historical replay mode.");
  }
  return {
    head: input.head,
    sourceCommit: input.sourceCommit,
    nightlyTag: input.nightlyTag,
    ...(input.replayMode ? { replayMode: input.replayMode } : {}),
    ...(typeof input.rollbackReason === "string"
      ? { rollbackReason: input.rollbackReason.trim() }
      : {}),
  };
}

export function assertRecoverySelection(
  worktree: string,
  selection: RecoverySelection,
  sourceCommit: string,
  requireNightly = true,
): void {
  if (selection.sourceCommit !== sourceCommit)
    throw new Error("Recovery source changed; incorporate new main commits and select again.");
  if (
    git(worktree, ["rev-parse", "HEAD"]) !== selection.head ||
    git(worktree, ["branch", "--show-current"]) !== `sync/nightly/${selection.nightlyTag}`
  ) {
    throw new Error("Retained recovery head or branch changed; select again.");
  }
  if (
    rebaseInProgress(worktree) ||
    git(worktree, ["status", "--porcelain", "--untracked-files=all"])
  ) {
    throw new Error("Recovery must be clean with its rebase completed and repairs committed.");
  }
  if (requireNightly && !isAncestor(worktree, selection.nightlyTag, selection.head)) {
    throw new Error("Recovery does not contain the selected upstream nightly.");
  }
}

export function continueCarryRecovery(input: {
  readonly repoRoot: string;
  readonly worktree: string;
  readonly selectedHead: string;
  readonly nightlyTag: string;
}): string {
  const plan = readCarryReplayPlan(input.worktree);
  if (!plan) return input.selectedHead;
  if (git(input.worktree, ["rev-parse", "HEAD"]) !== input.selectedHead) {
    throw new Error("Retained carry recovery head changed; inspect and select its exact head.");
  }
  const completed = completeCarryReplay(input.worktree);
  if (completed.phase !== "compile") return completed.head;
  console.log(
    `[lastcode:checkpoint] Carry compilation repaired; replaying it onto ${input.nightlyTag}...`,
  );
  return replayCarrySetOnto({
    repo: input.repoRoot,
    worktree: input.worktree,
    sourceBase: completed.sourceBase,
    compactHead: completed.head,
    onto: input.nightlyTag,
  }).head;
}

function main(argv: ReadonlyArray<string>): void {
  const options = parseArgs(argv);
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const commonDirectory = git(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const release = acquirePortableLock(
    commonDirectory,
    "lastcode-checkpoint",
    "checkpoint operation",
  );
  try {
    runCheckpoint(
      repoRoot,
      options,
      NodePath.join(commonDirectory, "lastcode-recovery-selection.json"),
    );
  } finally {
    release();
  }
}

function runCheckpoint(repoRoot: string, options: CheckpointOptions, selectionPath: string): void {
  const hostPlatform = Effect.runSync(HostProcessPlatform);
  let replay = resolveCheckpointReplay({
    configured: readManifestReplayConfiguration(NodePath.join(repoRoot, CARRY_MANIFEST_PATH)),
    ...(options.replayMode ? { requestedMode: options.replayMode } : {}),
    ...(options.rollbackReason ? { rollbackReason: options.rollbackReason } : {}),
  });
  if (options.selectRecovery && options.recoverySource) {
    const worktree = resolveAutomationWorktree(repoRoot);
    const branch = git(worktree, ["branch", "--show-current"]);
    const selected = parseRecoverySelection({
      head: options.selectRecovery,
      sourceCommit: options.recoverySource,
      nightlyTag: branch.replace(/^sync\/nightly\//, ""),
    });
    // Selection is an explicit assertion that the repaired tree includes this source.
    if (!options.dryRun) run(repoRoot, "git", ["fetch", options.pushRemote, "lastcode/main"]);
    assertRecoverySelection(
      worktree,
      selected,
      git(repoRoot, ["rev-parse", `${options.sourceRef}^{commit}`]),
      replay.mode !== "carry",
    );
    const carryPlan = replay.mode === "carry" ? readCarryReplayPlan(worktree) : undefined;
    if (options.dryRun && carryPlan) {
      console.log(
        `[lastcode:checkpoint] Would select repaired ${selected.nightlyTag} at ${selected.head}; retained carry replay will continue when the selection is recorded.`,
      );
      return;
    }
    const selectedHead = carryPlan
      ? continueCarryRecovery({
          repoRoot,
          worktree,
          selectedHead: selected.head,
          nightlyTag: selected.nightlyTag,
        })
      : selected.head;
    const selection = {
      ...selected,
      head: selectedHead,
      replayMode: replay.mode,
      ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
    };
    assertRecoverySelection(worktree, selection, selection.sourceCommit);
    if (!options.dryRun) {
      const temporaryPath = `${selectionPath}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(selection)}\n`, {
        mode: 0o600,
        flush: true,
      });
      NodeFS.renameSync(temporaryPath, selectionPath);
    }
    console.log(
      `[lastcode:checkpoint] ${options.dryRun ? "Would select" : "Selected"} repaired ${selection.nightlyTag} at ${selection.head}. Request a service run, then use Wait for Checkpoint.`,
    );
    return;
  }
  const selection = NodeFS.existsSync(selectionPath)
    ? parseRecoverySelection(JSON.parse(NodeFS.readFileSync(selectionPath, "utf8")))
    : undefined;
  if (selection?.replayMode && !options.replayMode) {
    replay = resolveCheckpointReplay({
      configured: readManifestReplayConfiguration(NodePath.join(repoRoot, CARRY_MANIFEST_PATH)),
      requestedMode: selection.replayMode,
      ...(selection.rollbackReason ? { rollbackReason: selection.rollbackReason } : {}),
    });
  }
  if (
    selection?.replayMode &&
    (selection.replayMode !== replay.mode || selection.rollbackReason !== replay.rollbackReason)
  ) {
    throw new Error(
      "Selected recovery replay mode changed; retry with its recorded mode and reason.",
    );
  }
  if (selection && (!options.smoke || !options.pushTags || options.promotion === "never")) {
    throw new Error("Selected recovery requires smoke validation, --push-tags, and promotion.");
  }
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
    run(repoRoot, "git", ["fetch", options.pushRemote, immutableSourceFetchRefspec()], {
      allowFailure: replay.configuredMode !== "carry",
    });
    if (replay.mode === "carry" && replay.bootstrap) {
      fetchCarryReplayRefs(repoRoot, options.pushRemote, replay.bootstrap);
    }
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

  if (replay.mode === "carry" && replay.bootstrap) {
    assertCarryBootstrapRef(repoRoot, replay.bootstrap);
  }

  if (options.mirrorUpstreamMain) mirrorUpstreamMain(repoRoot, options);

  if (options.pushTags && !options.dryRun) {
    pruneUnpublishedInstallableTags(repoRoot, options.pushRemote);
  }

  const sourceCommit = git(repoRoot, ["rev-parse", `${options.sourceRef}^{commit}`]);
  const checkpoints = listCheckpointRefs(repoRoot);
  const installables = listInstallableRefs(repoRoot);
  // A crash after pushing but before clearing the selection must not republish or
  // rebase the repaired commit. The published immutable tag now preserves it.
  if (selection && publishedRecoveryInstallable(installables, selection)) {
    if (!isAncestor(repoRoot, selection.head, sourceCommit))
      throw new Error(
        "Published recovery is not represented on main; inspect before releasing it.",
      );
    if (!options.dryRun)
      releasePublishedRecovery(
        repoRoot,
        resolveAutomationWorktree(repoRoot),
        selectionPath,
        selection,
      );
    console.log(
      "[lastcode:checkpoint] Selected recovery was already published; released its retained worktree. Run the service again to continue.",
    );
    return;
  }
  if (selection)
    assertRecoverySelection(resolveAutomationWorktree(repoRoot), selection, sourceCommit);
  const sourceAncestor = latestCheckpointAncestor(repoRoot, checkpoints, sourceCommit);
  const sourceNightlyTags = splitLines(
    git(repoRoot, ["tag", "--merged", sourceCommit, "--list", "v*-nightly.*"]),
  );
  const nightlyTags = splitLines(git(repoRoot, ["tag", "--list", "v*-nightly.*"]));
  const supersededNightly = supersedeFailedRecovery(
    repoRoot,
    nightlyTags,
    recoverySupersessionMode({
      dryRun: options.dryRun,
      enabled: options.supersedeFailedRecovery && !selection,
    }),
  );
  const plan =
    replay.configuredMode === "carry"
      ? {
          ...resolveCarryCheckpointPlan({
            checkpointRefs: checkpoints,
            installableRefs: installables,
            nightlyTags,
            bootstrapBase: replay.bootstrap?.base ?? "",
            resolveCommit: (ref) => git(repoRoot, ["rev-parse", `${ref}^{commit}`]),
          }),
          ...(replay.mode === "historical" ? { candidateRef: options.sourceRef } : {}),
        }
      : resolveCheckpointPlan({
          checkpointRefs: checkpoints,
          nightlyTags,
          sourceCommit,
          ...(sourceAncestor ? { sourceCheckpointTag: sourceAncestor.checkpointTag } : {}),
          sourceNightlyTags,
          sourceRef: options.sourceRef,
          ...(supersededNightly ? { supersedeThroughNightlyTag: supersededNightly.tag } : {}),
        });
  if (
    selection &&
    (plan.bootstrapCheckpoint
      ? plan.baseNightly.tag
      : (plan.missingNightlies[0]?.tag ??
        (replay.configuredMode === "carry" ? plan.baseNightly.tag : undefined))) !==
      selection.nightlyTag
  ) {
    throw new Error(
      "Selected recovery is not the next unpublished checkpoint; inspect before selecting again.",
    );
  }

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
      replayMode: replay.mode,
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

  if (selection) {
    const worktree = resolveAutomationWorktree(repoRoot);
    const startedAtMs = Date.now();
    const commitsRebased = Number(
      git(repoRoot, ["rev-list", "--count", `${selection.nightlyTag}..${selection.head}`]),
    );
    let pendingTag: string | undefined;
    let failurePhase: "publication" | "smoke" = "smoke";
    try {
      runSmokeGate(repoRoot, worktree);
      if (
        git(worktree, ["rev-parse", "HEAD"]) !== selection.head ||
        git(worktree, ["status", "--porcelain", "--untracked-files=all"])
      ) {
        throw new Error("Selected checkpoint changed during validation; retain and inspect it.");
      }
      failurePhase = "publication";
      const nightly = parseNightlyTag(selection.nightlyTag);
      if (!nightly) throw new Error("Selected recovery has an invalid nightly tag.");
      const finishedAtMs = Date.now();
      const timing = {
        commitsRebased,
        durationMs: finishedAtMs - startedAtMs,
        finishedAt: new Date(finishedAtMs).toISOString(),
        startedAt: new Date(startedAtMs).toISOString(),
      };
      pendingTag = checkpoints.some((checkpoint) => checkpoint.nightly.tag === nightly.tag)
        ? createRevisionTag(
            repoRoot,
            nextRevisionPlan(nightly, installables),
            selection.head,
            options.sourceRef,
            selection.sourceCommit,
            replay,
          )
        : createCheckpointTag(
            repoRoot,
            nightly,
            selection.head,
            options.sourceRef,
            selection.sourceCommit,
            replay,
            timing,
          );
      run(
        repoRoot,
        "git",
        recoveryPublicationArgs(
          options.pushRemote,
          pendingTag,
          selection,
          immutableRemoteSourceCommit(
            repoRoot,
            options.pushRemote,
            pendingTag,
            selection.sourceCommit,
          ),
        ),
      );
      const publishedTag = pendingTag;
      pendingTag = undefined;
      appendCheckpointRun({
        schemaVersion: 1,
        status: "success",
        upstreamTag: nightly.tag,
        ...timing,
        checkpointCommit: selection.head,
        checkpointTag: publishedTag,
        replayMode: replay.mode,
        ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
        sourceObjectRef: sourceObjectRef(publishedTag),
        sourceCommit: selection.sourceCommit,
      });
      releasePublishedRecovery(repoRoot, worktree, selectionPath, selection);
      runHistoricalShadowIfNeeded(repoRoot, publishedTag, replay);
      console.log(
        "[lastcode:checkpoint] Repaired checkpoint published and promoted. Run the service again for later nightlies.",
      );
      return;
    } catch (error) {
      if (pendingTag) deleteCheckpointTag(repoRoot, pendingTag);
      let recoveryFingerprint: string | undefined;
      if (failurePhase === "smoke") {
        try {
          recoveryFingerprint = checkpointRecoveryFingerprint(
            worktree,
            carryRecoveryBranch(selection.nightlyTag),
          );
        } catch {
          // The validation or publication error remains authoritative.
        }
      }
      appendCheckpointRun(
        checkpointFailureRecord({
          commitsRebased,
          error,
          failurePhase,
          recoveryBranch: carryRecoveryBranch(selection.nightlyTag),
          ...(recoveryFingerprint ? { recoveryFingerprint } : {}),
          replayMode: replay.mode,
          ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
          sourceCommit: selection.sourceCommit,
          startedAtMs,
          upstreamTag: selection.nightlyTag,
        }),
      );
      notify(
        hostPlatform,
        "LastCode checkpoint recovery needs attention",
        `${carryRecoveryBranch(selection.nightlyTag)} is retained at ${worktree}.`,
      );
      throw error;
    }
  }

  let candidateRef = plan.candidateRef === options.sourceRef ? sourceCommit : plan.candidateRef;
  let candidateCommit = git(repoRoot, ["rev-parse", `${candidateRef}^{commit}`]);
  let newestProducedInstallableTag: string | undefined;
  let carryWorktreePrepared = false;
  let carryBranch: string | undefined;
  const previousCompact: InstallableRef | undefined =
    "previousCompact" in plan ? (plan.previousCompact as InstallableRef | undefined) : undefined;
  const carryNeedsCompilation = carryCompilationNeeded({
    mode: replay.mode,
    ...(previousCompact ? { previousCompact } : {}),
    ...(selection ? { selection } : {}),
    sourceCommit,
  });
  const bootstrapRepresentedSource =
    carryNeedsCompilation && !previousCompact && replay.mode === "carry" && replay.bootstrap
      ? validateHistoricalBootstrapSource({
          bootstrap: replay.bootstrap,
          installables,
          repoRoot,
        })
      : undefined;
  if (carryNeedsCompilation) {
    const worktree = resolveAutomationWorktree(repoRoot);
    if (NodeFS.existsSync(worktree) && !selection) {
      throw new Error(
        `Nightly sync worktree already exists at ${worktree}. Resolve or remove it first.`,
      );
    }
    const firstNightly = plan.missingNightlies[0];
    carryBranch = carryRecoveryBranch(firstNightly?.tag ?? plan.baseNightly.tag);
    if (!selection) {
      NodeFS.mkdirSync(NodePath.dirname(worktree), { recursive: true });
      if (
        git(repoRoot, ["show-ref", "--verify", `refs/heads/${carryBranch}`], {
          allowFailure: true,
        })
      ) {
        throw new Error(`Recovery branch ${carryBranch} already exists.`);
      }
      run(repoRoot, "git", worktreeAddArgs(carryBranch, worktree, sourceCommit));
    }
    const startedAtMs = Date.now();
    try {
      const result = previousCompact
        ? compileCarrySetSameBase({
            repo: repoRoot,
            worktree,
            base: plan.baseNightly.tag,
            source: sourceCommit,
            previousCompactHead: previousCompact.commit,
            representedSource: representedSourceFor(previousCompact),
          })
        : compileCarrySetSameBase({
            repo: repoRoot,
            worktree,
            base: replay.bootstrap?.base ?? "",
            source: sourceCommit,
            preparedPartition: {
              base: replay.bootstrap?.base ?? "",
              source: replay.bootstrap?.source ?? "",
              head: replay.bootstrap?.head ?? "",
            },
            ...(bootstrapRepresentedSource
              ? { representedSource: bootstrapRepresentedSource }
              : {}),
          });
      candidateRef = result.head;
      candidateCommit = result.head;
      carryWorktreePrepared = true;
    } catch (error) {
      let recoveryFingerprint: string | undefined;
      try {
        recoveryFingerprint = checkpointRecoveryFingerprint(worktree, carryBranch);
      } catch (fingerprintError) {
        console.warn(
          `[lastcode:checkpoint] Could not fingerprint retained carry recovery: ${fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError)}`,
        );
      }
      appendCheckpointRun(
        checkpointFailureRecord({
          commitsRebased: 0,
          error,
          failurePhase: "rebase",
          recoveryBranch: carryBranch,
          ...(recoveryFingerprint ? { recoveryFingerprint } : {}),
          replayMode: replay.mode,
          sourceCommit,
          startedAtMs,
          upstreamTag: plan.missingNightlies[0]?.tag ?? plan.baseNightly.tag,
        }),
      );
      notify(hostPlatform, "LastCode carry replay needs attention", `${carryBranch} is retained.`);
      throw error;
    }
  }
  if (plan.bootstrapCheckpoint) {
    const startedAtMs = Date.now();
    let pendingCheckpointTag: string | undefined;
    let bootstrapFailurePhase: "publication" | "smoke" = "smoke";
    const commitsRebased = Number(
      git(repoRoot, ["rev-list", "--count", `${plan.baseNightly.tag}..${candidateCommit}`]),
    );
    try {
      if (carryWorktreePrepared) {
        const worktree = resolveAutomationWorktree(repoRoot);
        if (options.smoke) runSmokeGate(repoRoot, worktree);
        if (
          git(worktree, ["rev-parse", "HEAD"]) !== candidateCommit ||
          git(worktree, ["status", "--porcelain", "--untracked-files=all"])
        ) {
          throw new Error(
            "Carry bootstrap changed during validation; retain and inspect the worktree.",
          );
        }
      }
      bootstrapFailurePhase = "publication";
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
        replay,
        timing,
      );
      pendingCheckpointTag = checkpointTag;
      if (options.pushTags) {
        run(
          repoRoot,
          "git",
          installableTagPushArgs(
            repoRoot,
            options.pushRemote,
            checkpointTag,
            sourceCommit,
            carryWorktreePrepared && options.smoke
              ? { kind: "smoke" }
              : {
                  kind: "pre-push",
                  candidateCommit,
                  checkoutHead: git(
                    carryWorktreePrepared ? resolveAutomationWorktree(repoRoot) : repoRoot,
                    ["rev-parse", "HEAD"],
                  ),
                },
          ),
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
        replayMode: replay.mode,
        ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
        sourceObjectRef: sourceObjectRef(checkpointTag),
        sourceCommit,
      });
      newestProducedInstallableTag = checkpointTag;
    } catch (error) {
      const tagDeleted = pendingCheckpointTag
        ? deleteCheckpointTag(repoRoot, pendingCheckpointTag)
        : true;
      const disposition = carryBootstrapFailureDisposition({
        failurePhase: bootstrapFailurePhase,
        ...(pendingCheckpointTag ? { pendingCheckpointTag } : {}),
        ...(carryWorktreePrepared && carryBranch ? { recoveryBranch: carryBranch } : {}),
        tagDeleted,
      });
      const worktree = carryWorktreePrepared ? resolveAutomationWorktree(repoRoot) : undefined;
      let recoveryFingerprint: string | undefined;
      let recoveryBranch = disposition.recoveryBranch;
      if (disposition.cleanup && worktree && carryBranch) {
        try {
          run(repoRoot, "git", ["worktree", "remove", worktree]);
          git(repoRoot, ["update-ref", "-d", `refs/heads/${carryBranch}`]);
          carryWorktreePrepared = false;
        } catch (cleanupError) {
          recoveryBranch = carryBranch;
          console.warn(
            `[lastcode:checkpoint] Could not clean failed carry bootstrap; ${carryBranch} may be retained at ${worktree}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      if (recoveryBranch && worktree && NodeFS.existsSync(worktree)) {
        try {
          recoveryFingerprint = checkpointRecoveryFingerprint(worktree, recoveryBranch);
        } catch (fingerprintError) {
          console.warn(
            `[lastcode:checkpoint] Could not fingerprint retained carry bootstrap: ${fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError)}`,
          );
        }
      }
      const finishedAtMs = Date.now();
      appendCheckpointRun(
        checkpointFailureRecord(
          {
            commitsRebased,
            error,
            failurePhase: bootstrapFailurePhase,
            ...(!tagDeleted ? { localTagRetained: true } : {}),
            ...(recoveryBranch ? { recoveryBranch } : {}),
            ...(recoveryFingerprint ? { recoveryFingerprint } : {}),
            startedAtMs,
            upstreamTag: plan.baseNightly.tag,
            replayMode: replay.mode,
            sourceCommit,
            ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
          },
          finishedAtMs,
        ),
      );
      if (recoveryBranch) {
        notify(
          hostPlatform,
          "LastCode carry bootstrap needs attention",
          `${recoveryBranch} is retained at ${worktree}.`,
        );
        console.error(
          `[lastcode:checkpoint] Recovery branch ${recoveryBranch} is retained at ${worktree}.`,
        );
      }
      throw error;
    }
  }

  if (plan.missingNightlies.length === 0) {
    if (carryWorktreePrepared && !plan.bootstrapCheckpoint) {
      const worktree = resolveAutomationWorktree(repoRoot);
      const revisionPlan = nextRevisionPlan(plan.baseNightly, installables);
      const startedAtMs = Date.now();
      let pendingTag: string | undefined;
      let carryRevisionFailurePhase: "publication" | "smoke" = "smoke";
      try {
        if (options.smoke) runSmokeGate(repoRoot, worktree);
        if (
          git(worktree, ["rev-parse", "HEAD"]) !== candidateCommit ||
          git(worktree, ["status", "--porcelain", "--untracked-files=all"])
        ) {
          throw new Error(
            "Carry revision changed during validation; retain and inspect the worktree.",
          );
        }
        carryRevisionFailurePhase = "publication";
        pendingTag = createRevisionTag(
          repoRoot,
          revisionPlan,
          candidateCommit,
          options.sourceRef,
          sourceCommit,
          replay,
        );
        if (options.pushTags) {
          run(
            repoRoot,
            "git",
            installableTagPushArgs(
              repoRoot,
              options.pushRemote,
              pendingTag,
              sourceCommit,
              options.smoke
                ? { kind: "smoke" }
                : {
                    kind: "pre-push",
                    candidateCommit,
                    checkoutHead: git(worktree, ["rev-parse", "HEAD"]),
                  },
            ),
          );
        }
        const finishedAtMs = Date.now();
        appendCheckpointRun({
          schemaVersion: 1,
          status: "success",
          upstreamTag: revisionPlan.nightly.tag,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          commitsRebased: 0,
          checkpointCommit: candidateCommit,
          checkpointTag: pendingTag,
          replayMode: replay.mode,
          sourceObjectRef: sourceObjectRef(pendingTag),
          sourceCommit,
        });
        newestProducedInstallableTag = pendingTag;
        pendingTag = undefined;
      } catch (error) {
        if (pendingTag) deleteCheckpointTag(repoRoot, pendingTag);
        let recoveryFingerprint: string | undefined;
        if (carryBranch) {
          try {
            recoveryFingerprint = checkpointRecoveryFingerprint(worktree, carryBranch);
          } catch {
            // The original validation or publication error remains authoritative.
          }
        }
        appendCheckpointRun(
          checkpointFailureRecord({
            commitsRebased: 0,
            error,
            failurePhase: carryRevisionFailurePhase,
            ...(carryBranch ? { recoveryBranch: carryBranch } : {}),
            ...(recoveryFingerprint ? { recoveryFingerprint } : {}),
            replayMode: replay.mode,
            sourceCommit,
            startedAtMs,
            upstreamTag: revisionPlan.nightly.tag,
          }),
        );
        notify(
          hostPlatform,
          "LastCode carry revision needs attention",
          `${carryBranch ?? "Carry revision"} is retained at ${worktree}.`,
        );
        throw error;
      }
      run(repoRoot, "git", ["worktree", "remove", worktree]);
      if (carryBranch) git(repoRoot, ["update-ref", "-d", `refs/heads/${carryBranch}`]);
      runPromotionThenShadow(
        () =>
          promoteCheckpoint(
            repoRoot,
            candidateCommit,
            options,
            sourceCommit,
            options.smoke || options.pushTags,
          ),
        () => runHistoricalShadowIfNeeded(repoRoot, newestProducedInstallableTag, replay),
      );
      console.log(`[lastcode:checkpoint] Created ${newestProducedInstallableTag}.`);
      return;
    }
    if (carryWorktreePrepared && plan.bootstrapCheckpoint) {
      const worktree = resolveAutomationWorktree(repoRoot);
      run(repoRoot, "git", ["worktree", "remove", worktree]);
      if (carryBranch) git(repoRoot, ["update-ref", "-d", `refs/heads/${carryBranch}`]);
      carryWorktreePrepared = false;
    }
    const revisionPublication = !plan.bootstrapCheckpoint
      ? publishRevisionIfNeeded(
          repoRoot,
          options.sourceRef,
          sourceCommit,
          installables,
          options,
          hostPlatform,
          replay,
        )
      : { handled: false };
    if (revisionPublication.handled) {
      console.log("[lastcode:checkpoint] No uncheckpointed upstream nightlies remain.");
      return;
    }
    runPromotionThenShadow(
      () => promoteCheckpoint(repoRoot, candidateCommit, options, sourceCommit, options.pushTags),
      () => runHistoricalShadowIfNeeded(repoRoot, newestProducedInstallableTag, replay),
    );
    console.log("[lastcode:checkpoint] No uncheckpointed upstream nightlies remain.");
    return;
  }

  const worktree = resolveAutomationWorktree(repoRoot);
  if (NodeFS.existsSync(worktree) && !selection && !carryWorktreePrepared) {
    throw new Error(
      `Nightly sync worktree already exists at ${worktree}. Resolve or remove it first.`,
    );
  }
  NodeFS.mkdirSync(NodePath.dirname(worktree), { recursive: true });
  const firstNightly = plan.missingNightlies[0];
  if (!firstNightly) throw new Error("Missing first nightly checkpoint.");
  let branch = carryBranch ?? `sync/nightly/${firstNightly.tag}`;
  if (
    !selection &&
    !carryWorktreePrepared &&
    git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`], { allowFailure: true })
  ) {
    throw new Error(`Recovery branch ${branch} already exists.`);
  }

  if (!selection && !carryWorktreePrepared)
    run(repoRoot, "git", worktreeAddArgs(branch, worktree, candidateCommit));
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
  let historicalCompactFallback = replay.mode === "historical" && replay.configuredMode === "carry";
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
      if (replay.mode === "carry") {
        replayCarrySetOnto({
          repo: repoRoot,
          worktree,
          sourceBase: baseTag,
          compactHead: git(worktree, ["rev-parse", "HEAD"]),
          onto: nightly.tag,
        });
      } else if (historicalCompactFallback && previousCompact) {
        replayUngroupedOnto({
          repo: repoRoot,
          worktree,
          sourceBase: baseTag,
          currentSource: git(worktree, ["rev-parse", "HEAD"]),
          onto: nightly.tag,
          representedCompactHead: previousCompact.commit,
          representedSource: representedSourceFor(previousCompact),
        });
        historicalCompactFallback = false;
      } else {
        rebaseOnto(worktree, nightly.tag, baseTag);
      }
      candidateCommit = git(repoRoot, ["rev-parse", "HEAD"], { cwd: worktree });
      const historicalInstallable = !previousCompact
        ? installables.findLast(
            (installable) =>
              installable.nightly.tag === nightly.tag && installable.replayMode !== "carry",
          )
        : undefined;
      if (replay.mode === "carry" && historicalInstallable) {
        if (!historicalInstallable.sourceCommit) {
          throw new Error(
            `Historical installable ${historicalInstallable.tag} has no Source-Commit; refusing to replace its unverified integration resolutions.`,
          );
        }
        const unexpected = unexpectedHistoricalCheckpointChanges({
          repoRoot,
          historicalCommit: historicalInstallable.commit,
          candidateCommit,
          representedSource: historicalInstallable.sourceCommit,
          currentSource: sourceCommit,
        });
        if (unexpected.length > 0) {
          throw new Error(
            `Carry replay would drop historical integration resolutions outside current source changes: ${unexpected.join(", ")}. Fold them into their owning carry groups before publication.`,
          );
        }
      }
      failurePhase = "smoke";
      if (options.smoke) runSmokeGate(repoRoot, worktree);
      if (
        git(worktree, ["rev-parse", "HEAD"]) !== candidateCommit ||
        git(worktree, ["status", "--porcelain", "--untracked-files=all"])
      ) {
        throw new Error("Checkpoint changed during validation; retain and inspect the worktree.");
      }
      failurePhase = "publication";
      const finishedAtMs = Date.now();
      const timing = {
        commitsRebased: attempt.commitsRebased,
        durationMs: finishedAtMs - attempt.startedAtMs,
        finishedAt: new Date(finishedAtMs).toISOString(),
        startedAt: new Date(attempt.startedAtMs).toISOString(),
      };
      const checkpointTag = checkpoints.some((checkpoint) => checkpoint.nightly.tag === nightly.tag)
        ? createRevisionTag(
            repoRoot,
            nextRevisionPlan(nightly, installables),
            candidateCommit,
            options.sourceRef,
            sourceCommit,
            replay,
          )
        : createCheckpointTag(
            repoRoot,
            nightly,
            candidateCommit,
            options.sourceRef,
            sourceCommit,
            replay,
            timing,
          );
      pendingCheckpointTag = checkpointTag;
      if (options.pushTags) {
        if (selection) {
          run(
            repoRoot,
            "git",
            recoveryPublicationArgs(
              options.pushRemote,
              checkpointTag,
              selection,
              immutableRemoteSourceCommit(
                repoRoot,
                options.pushRemote,
                checkpointTag,
                sourceCommit,
              ),
            ),
          );
        } else {
          run(
            repoRoot,
            "git",
            installableTagPushArgs(
              repoRoot,
              options.pushRemote,
              checkpointTag,
              sourceCommit,
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
      }
      pendingCheckpointTag = undefined;
      appendCheckpointRun({
        schemaVersion: 1,
        status: "success",
        upstreamTag: nightly.tag,
        ...timing,
        checkpointCommit: candidateCommit,
        checkpointTag,
        replayMode: replay.mode,
        ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
        sourceObjectRef: sourceObjectRef(checkpointTag),
        sourceCommit,
      });
      newestProducedInstallableTag = checkpointTag;
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
    const disposition = checkpointFailureDisposition(
      pendingCheckpointTag,
      branch,
      tagDeleted,
      selection !== undefined,
    );
    completed = disposition.cleanup;
    if (attempt) {
      const finishedAtMs = Date.now();
      let recoveryFingerprint: string | undefined;
      if (disposition.recoveryBranch && (failurePhase === "rebase" || failurePhase === "smoke")) {
        try {
          recoveryFingerprint = checkpointRecoveryFingerprint(worktree, disposition.recoveryBranch);
        } catch (fingerprintError) {
          console.warn(
            `[lastcode:checkpoint] Could not fingerprint retained recovery: ${fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError)}`,
          );
        }
      }
      appendCheckpointRun(
        checkpointFailureRecord(
          {
            commitsRebased: attempt.commitsRebased,
            error,
            ...(failurePhase ? { failurePhase } : {}),
            ...(!tagDeleted ? { localTagRetained: true } : {}),
            ...(disposition.recoveryBranch ? { recoveryBranch: disposition.recoveryBranch } : {}),
            ...(recoveryFingerprint ? { recoveryFingerprint } : {}),
            startedAtMs: attempt.startedAtMs,
            upstreamTag: attempt.nightly.tag,
            replayMode: replay.mode,
            sourceCommit,
            ...(replay.rollbackReason ? { rollbackReason: replay.rollbackReason } : {}),
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
    runHistoricalShadowIfNeeded(repoRoot, newestProducedInstallableTag, replay);
    throw error;
  } finally {
    if (completed) {
      if (selection) {
        releasePublishedRecovery(repoRoot, worktree, selectionPath, selection);
      } else {
        run(repoRoot, "git", ["worktree", "remove", worktree]);
        git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`]);
      }
    }
  }

  if (selection) {
    runHistoricalShadowIfNeeded(repoRoot, newestProducedInstallableTag, replay);
    console.log(
      "[lastcode:checkpoint] Repaired checkpoint published and promoted. Run the service again for later nightlies.",
    );
    return;
  }

  runPromotionThenShadow(
    () =>
      promoteCheckpoint(
        repoRoot,
        candidateCommit,
        options,
        sourceCommit,
        options.smoke || options.pushTags,
      ),
    () => runHistoricalShadowIfNeeded(repoRoot, newestProducedInstallableTag, replay),
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
