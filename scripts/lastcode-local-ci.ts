#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Host-side CI owns subprocesses and cancellation timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeTimers from "node:timers";
import {
  DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  type LastCodeLocalCiSettings,
} from "@t3tools/contracts/settings";

import { cleanGitEnvironment, parseLastCodeInstallableTag } from "./lastcode-nightly.ts";
import { lastCodeAction } from "./lib/lastcode-action-kit.ts";
import {
  acquireLocalCiBudget,
  readLocalCiPolicy,
  tryAcquireLocalCiBudget,
} from "./lib/lastcode-ci-budget.ts";
import { resolveQuickCiScope, type QuickCiScope } from "./lib/lastcode-ci-scope.ts";
import { runCiProcess } from "./lib/lastcode-ci-process.ts";

export const LASTCODE_BASE_BRANCH = "lastcode/main";
export const LASTCODE_ORIGIN_REMOTE = "origin";
export const UPSTREAM_BASE_BRANCH = "main";
export const UPSTREAM_REMOTE = "upstream";

export type LocalCiMode = "quick" | "full";

interface CommandStep {
  readonly kind: "command";
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly failureHelp?: string;
  readonly isolatedGitConfig?: boolean;
  readonly rustToolchainPath?: boolean;
  readonly transferBudgetOutput?: boolean;
}

interface VerifyPreloadStep {
  readonly kind: "verify-preload";
  readonly label: string;
}

interface DiffWhitespaceStep {
  readonly kind: "diff-whitespace";
  readonly label: string;
}

export type LocalCiStep = CommandStep | VerifyPreloadStep | DiffWhitespaceStep;

export const QUICK_CI_GATE_VERSION = 2;

export interface QuickCiReceipt {
  readonly schemaVersion: 1;
  readonly gateVersion: typeof QUICK_CI_GATE_VERSION;
  readonly commit: string;
  readonly baseCommit: string;
  readonly baseRef: string;
  readonly completedAt: string;
}

export interface QuickCiBase {
  readonly branch: string;
  readonly remote: string;
  readonly remoteRef: string;
}

export interface PrePushUpdate {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

export interface FullCiStamp {
  readonly schemaVersion: 2;
  readonly commit: string;
  readonly completedAt: string;
  readonly context:
    | {
        readonly kind: "pull-request";
        readonly baseCommit: string;
        readonly baseRef: typeof LASTCODE_BASE_BRANCH;
      }
    | {
        readonly kind: "checkpoint";
        readonly checkpointTag: string;
        readonly upstreamCommit: string;
        readonly upstreamTag: string;
      };
}

export interface LocalCiOptions {
  readonly mode: LocalCiMode;
  readonly dryRun: boolean;
  readonly prePush: boolean;
  readonly checkpointTag?: string;
  readonly requireLocal?: boolean;
}

export interface RepositoryIntegritySnapshot {
  readonly branchConfig: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly commonGitDir: string;
  readonly configPath: string;
  readonly localBranches: ReadonlySet<string>;
  readonly protectedConfig: string;
}

export interface PreparedLocalCiRepository {
  readonly integrity: RepositoryIntegritySnapshot;
  readonly repoRoot: string;
}

export function formatLocalCiSummary(
  mode: LocalCiMode,
  commit?: string,
  baseCommit?: string,
): string {
  return mode === "full"
    ? `[lastcode:ci] Summary: Full local CI passed${commit ? ` for ${commit}` : ""}.`
    : `[lastcode:ci] Summary: Quick local CI passed${commit ? ` for ${commit}` : ""}${baseCommit ? ` against ${baseCommit}` : ""}.`;
}

export function formatLocalCiFailureSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  return `[lastcode:ci] Summary: failed: ${message || "Unknown error."}`;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const supported = major === 24 && (minor > 13 || (minor === 13 && patch >= 1));
  if (!supported) {
    throw new Error(
      `LastCode local CI requires Node ^24.13.1, received ${version}. Run it through the package script so mise selects the project runtime.`,
    );
  }
}

const QUICK_STEPS: ReadonlyArray<LocalCiStep> = [
  { kind: "diff-whitespace", label: "Diff whitespace" },
  { kind: "command", label: "Format and lint", command: "vp", args: ["check"] },
  { kind: "command", label: "Workspace typecheck", command: "vpr", args: ["typecheck"] },
];

const FULL_STEPS: ReadonlyArray<LocalCiStep> = [
  {
    kind: "command",
    label: "Ensure Electron runtime",
    command: "vp",
    args: ["run", "--filter", "@t3tools/desktop", "ensure:electron"],
  },
  { kind: "command", label: "Format and lint", command: "vp", args: ["check"] },
  { kind: "command", label: "Workspace typecheck", command: "vpr", args: ["typecheck"] },
  {
    kind: "command",
    label: "Workspace tests",
    command: "vp",
    args: [
      "run",
      "--recursive",
      "--concurrency-limit",
      "1",
      "test",
      "--maxWorkers=1",
      "--maxConcurrency=1",
    ],
    isolatedGitConfig: true,
    transferBudgetOutput: true,
  },
  {
    kind: "command",
    label: "Resource monitor formatting",
    command: "cargo",
    args: ["fmt", "--manifest-path", "native/resource-monitor/Cargo.toml", "--", "--check"],
    rustToolchainPath: true,
  },
  {
    kind: "command",
    label: "Desktop build",
    command: "vp",
    args: ["run", "build:desktop"],
  },
  { kind: "verify-preload", label: "Desktop preload bundle assertions" },
  {
    kind: "command",
    label: "Resource monitor tests",
    command: "cargo",
    args: ["test", "--locked", "--manifest-path", "native/resource-monitor/Cargo.toml"],
    rustToolchainPath: true,
  },
  {
    kind: "command",
    label: "Mobile native tool prerequisites",
    command: "env",
    // A prerequisite check must not update Homebrew or leave analytics children running.
    args: [
      "HOMEBREW_NO_AUTO_UPDATE=1",
      "HOMEBREW_NO_ANALYTICS=1",
      "brew",
      "bundle",
      "check",
      "--file",
      "apps/mobile/Brewfile",
    ],
    failureHelp: "Install missing tools with: brew bundle install --file apps/mobile/Brewfile",
  },
  {
    kind: "command",
    label: "Mobile native static analysis",
    command: "vp",
    args: ["run", "lint:mobile"],
  },
  {
    kind: "command",
    label: "Release smoke",
    command: "node",
    args: ["scripts/release-smoke.ts"],
  },
];

const PRELOAD_PATH = "apps/desktop/dist-electron/preload.cjs";
const PRELOAD_EXPECTED_EXPORTS = [
  "desktopBridge",
  "getLocalEnvironmentBootstraps",
  "PICK_FOLDER_CHANNEL",
  "__clerk_internal_electron_passkeys",
] as const;

export function parseLocalCiOptions(argv: ReadonlyArray<string>): LocalCiOptions {
  let mode: LocalCiMode = "full";
  let dryRun = false;
  let prePush = false;
  let checkpointTag: string | undefined;
  let requireLocal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--full") {
      mode = "full";
    } else if (arg === "--quick") {
      mode = "quick";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--pre-push") {
      prePush = true;
    } else if (arg === "--require-local") {
      requireLocal = true;
    } else if (arg === "--checkpoint") {
      checkpointTag = argv[index + 1];
      if (!checkpointTag) throw new Error("Missing value for --checkpoint.");
      index += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  if (prePush && mode !== "quick") {
    throw new Error("--pre-push is only supported with --quick.");
  }
  if (requireLocal && mode !== "quick") {
    throw new Error("--require-local is only supported with --quick.");
  }

  return {
    mode,
    dryRun,
    prePush,
    ...(checkpointTag ? { checkpointTag } : {}),
    ...(requireLocal ? { requireLocal } : {}),
  };
}

export function resolveLocalCiSteps(
  mode: LocalCiMode,
  scope?: QuickCiScope,
  policy: LastCodeLocalCiSettings = DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
  repoRoot = process.cwd(),
): ReadonlyArray<LocalCiStep> {
  const steps = mode === "quick" ? QUICK_STEPS : FULL_STEPS;
  return steps.flatMap((step): LocalCiStep[] => {
    if (step.kind !== "command") return [step];
    if (step.label === "Workspace typecheck") {
      if (mode === "quick" && scope?.kind === "none") return [];
      const filters =
        mode === "quick" && scope?.kind === "affected"
          ? scope.packages.flatMap((name) => ["--filter", name])
          : [];
      return [
        {
          ...step,
          command: "vp",
          args: [
            "run",
            ...(filters.length === 0 ? ["--recursive"] : []),
            "--concurrency-limit",
            String(policy.packageConcurrency),
            ...filters,
            "typecheck",
          ],
        },
      ];
    }
    if (mode === "quick" && scope && scope.kind !== "full" && step.label === "Format and lint") {
      const paths = scope.changedFiles
        .filter((path) => NodeFS.existsSync(NodePath.join(repoRoot, path)))
        .map((path) => `./${path}`);
      if (paths.length === 0) return [];
      return [{ ...step, args: ["check", "--no-error-on-unmatched-pattern", ...paths] }];
    }
    return [step];
  });
}

export function verifyPreloadBundle(repoRoot: string): void {
  const preloadPath = NodePath.resolve(repoRoot, PRELOAD_PATH);
  if (!NodeFS.existsSync(preloadPath)) {
    throw new Error(`Expected desktop preload bundle at ${PRELOAD_PATH}.`);
  }

  const contents = NodeFS.readFileSync(preloadPath, "utf8");
  for (const expectedExport of PRELOAD_EXPECTED_EXPORTS) {
    if (!contents.includes(expectedExport)) {
      throw new Error(`Desktop preload bundle is missing '${expectedExport}'.`);
    }
  }
}

export function parsePrePushUpdates(input: string): ReadonlyArray<PrePushUpdate> {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(/\s+/);
      if (fields.length !== 4) {
        throw new Error(`Invalid pre-push update: ${line}`);
      }
      const [localRef, localSha, remoteRef, remoteSha] = fields;
      return {
        localRef: localRef!,
        localSha: localSha!,
        remoteRef: remoteRef!,
        remoteSha: remoteSha!,
      };
    });
}

export function assertPrePushTargetsHead(
  updates: ReadonlyArray<PrePushUpdate>,
  headCommit: string,
): boolean {
  if (!hasPrePushBranchCommit(updates)) return false;
  const commits = updates
    .filter(({ remoteRef }) => remoteRef.startsWith("refs/heads/"))
    .map(({ localSha }) => localSha)
    .filter((localSha) => !/^0+$/.test(localSha));
  const mismatched = commits.find((commit) => commit !== headCommit);
  if (mismatched) {
    throw new Error(
      `Pre-push Quick CI only supports refs at the checked-out HEAD ${headCommit}; received ${mismatched}. Push refs separately.`,
    );
  }
  return true;
}

export function hasPrePushBranchCommit(updates: ReadonlyArray<PrePushUpdate>): boolean {
  if (updates.length === 0) {
    throw new Error("The pre-push hook did not receive any ref updates.");
  }
  return updates.some(
    ({ localSha, remoteRef }) => remoteRef.startsWith("refs/heads/") && !/^0+$/.test(localSha),
  );
}

export function resolveQuickCiBase(branchName: string): QuickCiBase {
  const upstreamWorkstream =
    branchName === UPSTREAM_BASE_BRANCH ||
    branchName.startsWith("fix/") ||
    branchName.startsWith("feat/");
  const remote = upstreamWorkstream ? UPSTREAM_REMOTE : LASTCODE_ORIGIN_REMOTE;
  const branch = upstreamWorkstream ? UPSTREAM_BASE_BRANCH : LASTCODE_BASE_BRANCH;
  return {
    branch,
    remote,
    remoteRef: `refs/remotes/${remote}/${branch}`,
  };
}

export function resolveQuickCiReceiptPath(commonGitDir: string, commit: string): string {
  return NodePath.resolve(commonGitDir, "lastcode-ci", "quick", `${commit}.json`);
}

export function writeQuickCiReceipt(
  commonGitDir: string,
  receipt: Omit<QuickCiReceipt, "schemaVersion" | "gateVersion">,
): string {
  const receiptPath = resolveQuickCiReceiptPath(commonGitDir, receipt.commit);
  NodeFS.mkdirSync(NodePath.dirname(receiptPath), { recursive: true });
  const pendingPath = `${receiptPath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(
    pendingPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gateVersion: QUICK_CI_GATE_VERSION,
        ...receipt,
      } satisfies QuickCiReceipt,
      null,
      2,
    )}\n`,
  );
  try {
    NodeFS.renameSync(pendingPath, receiptPath);
  } finally {
    NodeFS.rmSync(pendingPath, { force: true });
  }
  return receiptPath;
}

export function readQuickCiReceipt(
  commonGitDir: string,
  commit: string,
): QuickCiReceipt | undefined {
  const receiptPath = resolveQuickCiReceiptPath(commonGitDir, commit);
  if (!NodeFS.existsSync(receiptPath)) return undefined;

  const value = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8")) as Partial<QuickCiReceipt>;
  // A gate change invalidates previously successful checks; it is a cache miss.
  if (value.schemaVersion === 1 && value.gateVersion !== QUICK_CI_GATE_VERSION) return undefined;
  if (
    value.schemaVersion !== 1 ||
    value.gateVersion !== QUICK_CI_GATE_VERSION ||
    value.commit !== commit ||
    typeof value.baseCommit !== "string" ||
    typeof value.baseRef !== "string" ||
    typeof value.completedAt !== "string"
  ) {
    throw new Error(`Invalid Quick CI receipt at ${receiptPath}.`);
  }
  return value as QuickCiReceipt;
}

export function hasMatchingQuickCiReceipt(
  commonGitDir: string,
  commit: string,
  baseCommit: string,
  baseRef: string,
): boolean {
  const receipt = readQuickCiReceipt(commonGitDir, commit);
  return receipt?.baseCommit === baseCommit && receipt.baseRef === baseRef;
}

export function resolveFullCiStampPath(commonGitDir: string, commit: string): string {
  return NodePath.resolve(commonGitDir, "lastcode-ci", `${commit}.json`);
}

export function writeFullCiStamp(
  commonGitDir: string,
  stamp: Omit<FullCiStamp, "schemaVersion">,
): string {
  const stampPath = resolveFullCiStampPath(commonGitDir, stamp.commit);
  NodeFS.mkdirSync(NodePath.dirname(stampPath), { recursive: true });
  NodeFS.writeFileSync(
    stampPath,
    `${JSON.stringify({ schemaVersion: 2, ...stamp } satisfies FullCiStamp, null, 2)}\n`,
  );
  return stampPath;
}

export function readFullCiStamp(commonGitDir: string, commit: string): FullCiStamp | undefined {
  const stampPath = resolveFullCiStampPath(commonGitDir, commit);
  if (!NodeFS.existsSync(stampPath)) return undefined;

  const value = JSON.parse(NodeFS.readFileSync(stampPath, "utf8")) as Partial<FullCiStamp>;
  if (
    value.schemaVersion !== 2 ||
    value.commit !== commit ||
    typeof value.context !== "object" ||
    value.context === null ||
    typeof value.completedAt !== "string"
  ) {
    throw new Error(`Invalid LastCode CI stamp at ${stampPath}.`);
  }
  return value as FullCiStamp;
}

export function assertFullCiStamp(
  commonGitDir: string,
  commit: string,
  baseCommit: string,
): FullCiStamp {
  const stamp = readFullCiStamp(commonGitDir, commit);
  if (!stamp) {
    throw new Error(`Commit ${commit} has not passed full local CI. Run: pnpm lastcode:ci`);
  }
  if (stamp.context.kind !== "pull-request" || stamp.context.baseCommit !== baseCommit) {
    throw new Error(
      `Full local CI was not run against the current ${LASTCODE_BASE_BRANCH} commit ${baseCommit}. Rebase and rerun: pnpm lastcode:ci`,
    );
  }
  return stamp;
}

export function assertCheckpointCiStamp(
  commonGitDir: string,
  commit: string,
  checkpointTag: string,
  upstreamCommit: string,
): FullCiStamp {
  const stamp = readFullCiStamp(commonGitDir, commit);
  if (!stamp) {
    throw new Error(
      `Installable ${checkpointTag} at ${commit} has not passed full local CI. Run: pnpm lastcode:ci --checkpoint ${checkpointTag}`,
    );
  }
  if (
    stamp.context.kind !== "checkpoint" ||
    stamp.context.checkpointTag !== checkpointTag ||
    stamp.context.upstreamCommit !== upstreamCommit
  ) {
    throw new Error(
      `Full local CI stamp for ${commit} does not match installable ${checkpointTag}. Rerun: pnpm lastcode:ci --checkpoint ${checkpointTag}`,
    );
  }
  return stamp;
}

function runProcess(
  repoRoot: string,
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly capture?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly failureHelp?: string;
  } = {},
): string {
  const inheritedEnv = cleanGitEnvironment(options.env ?? process.env);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...inheritedEnv,
      PATH: `${NodePath.resolve(repoRoot, "node_modules/.bin")}${NodePath.delimiter}${inheritedEnv.PATH ?? ""}`,
    },
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = options.capture ? result.stderr.trim() : "";
    const details = [
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
      stderr,
      options.failureHelp ?? "",
    ].filter(Boolean);
    throw new Error(details.join("\n"));
  }

  return options.capture ? result.stdout.trim() : "";
}

export function runGit(repoRoot: string, args: ReadonlyArray<string>): string {
  return runProcess(repoRoot, "git", args, { capture: true });
}

async function runGitWithCancellation(
  repoRoot: string,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const inheritedEnv = cleanGitEnvironment(process.env);
  return new Promise((resolve, reject) => {
    // These read-only guards need a captured Git child, not another CI worker.
    // Await close even on cancellation so cleanup precedes lease release.
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd: repoRoot,
      env: {
        ...inheritedEnv,
        PATH: `${NodePath.resolve(repoRoot, "node_modules/.bin")}${NodePath.delimiter}${inheritedEnv.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let terminationTimer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      terminationTimer = NodeTimers.setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (terminationTimer !== undefined) NodeTimers.clearTimeout(terminationTimer);
      if (signal.aborted) return reject(signal.reason ?? new Error("Local CI cancelled."));
      if (spawnError) return reject(spawnError);
      if (code !== 0) {
        return reject(
          new Error(
            `git ${args.join(" ")} failed with exit code ${code ?? "unknown"}.\n${stderr.trim()}`,
          ),
        );
      }
      resolve(stdout.trim());
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function resolveRepoRoot(cwd = process.cwd()): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function resolveCommonGitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

function readCoreBare(repoRoot: string, configPath: string): string {
  return runProcess(
    repoRoot,
    "git",
    ["config", "--file", configPath, "--bool", "--get", "core.bare"],
    {
      capture: true,
    },
  );
}

function readConfigEntries(repoRoot: string, configPath: string): ReadonlyArray<string> {
  return runProcess(repoRoot, "git", ["config", "--file", configPath, "--null", "--list"], {
    capture: true,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function readProtectedConfig(entries: ReadonlyArray<string>): string {
  return entries.filter((entry) => !entry.startsWith("branch.")).join("\0");
}

function readBranchConfig(
  entries: ReadonlyArray<string>,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const config: Record<string, Array<string>> = {};
  for (const entry of entries) {
    if (!entry.startsWith("branch.")) continue;
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    (config[key] ??= []).push(value);
  }
  return config;
}

function readLocalBranches(repoRoot: string): ReadonlySet<string> {
  return new Set(
    runGit(repoRoot, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])
      .split("\n")
      .filter((branch) => branch.length > 0),
  );
}

export function captureRepositoryIntegrity(repoRoot: string): RepositoryIntegritySnapshot {
  const commonGitDir = resolveCommonGitDir(repoRoot);
  const configPath = NodePath.join(commonGitDir, "config");
  const coreBare = readCoreBare(repoRoot, configPath);
  if (coreBare !== "false") {
    throw new Error(
      `Refusing local CI because the shared repository config reports core.bare=${coreBare || "unset"}. Inspect ${configPath} before continuing.`,
    );
  }
  const configEntries = readConfigEntries(repoRoot, configPath);
  return {
    branchConfig: readBranchConfig(configEntries),
    commonGitDir,
    configPath,
    localBranches: readLocalBranches(repoRoot),
    protectedConfig: readProtectedConfig(configEntries),
  };
}

export function prepareLocalCiRepository(cwd = process.cwd()): PreparedLocalCiRepository {
  // Validate the shared config before asking Git for a worktree root. A damaged
  // core.bare setting makes --show-toplevel fail before we can name the config.
  const integrity = captureRepositoryIntegrity(cwd);
  return { integrity, repoRoot: resolveRepoRoot(cwd) };
}

export async function assertRepositoryIntegrity(
  repoRoot: string,
  before: RepositoryIntegritySnapshot,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const coreBare = await runGitWithCancellation(
    repoRoot,
    ["config", "--file", before.configPath, "--bool", "--get", "core.bare"],
    signal,
  );
  if (coreBare !== "false") {
    throw new Error(
      `Shared repository integrity changed during local CI: core.bare=${coreBare || "unset"}. Stop and inspect ${before.configPath}.`,
    );
  }
  const configEntries = (
    await runGitWithCancellation(
      repoRoot,
      ["config", "--file", before.configPath, "--null", "--list"],
      signal,
    )
  )
    .split("\0")
    .filter((entry) => entry.length > 0);
  const protectedConfig = readProtectedConfig(configEntries);
  if (protectedConfig !== before.protectedConfig) {
    throw new Error(
      `Shared repository integrity changed during local CI: protected settings in ${before.configPath} were modified. Stop and inspect the config before continuing.`,
    );
  }
  const branchConfig = readBranchConfig(configEntries);
  const localBranches = new Set(
    (
      await runGitWithCancellation(
        repoRoot,
        ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"],
        signal,
      )
    )
      .split("\n")
      .filter((branch) => branch.length > 0),
  );
  for (const [key, values] of Object.entries(before.branchConfig)) {
    if (JSON.stringify(branchConfig[key]) !== JSON.stringify(values)) {
      const branch = key.slice("branch.".length, key.lastIndexOf("."));
      // Renaming or deleting a sibling branch removes its shared config keys.
      if (
        branchConfig[key] === undefined &&
        before.localBranches.has(branch) &&
        !localBranches.has(branch)
      ) {
        continue;
      }
      throw new Error(
        `Shared repository integrity changed during local CI: existing branch setting ${key} in ${before.configPath} was modified. Stop and inspect the config before continuing.`,
      );
    }
  }
  const commonGitDir = await runGitWithCancellation(
    repoRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  if (commonGitDir !== before.commonGitDir) {
    throw new Error(
      `Shared repository integrity changed during local CI: common Git directory moved from ${before.commonGitDir} to ${commonGitDir}.`,
    );
  }
}

export async function writeVerifiedFullCiStamp(
  repoRoot: string,
  integrity: RepositoryIntegritySnapshot,
  stamp: Omit<FullCiStamp, "schemaVersion">,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  await assertRepositoryIntegrity(repoRoot, integrity, signal);
  signal.throwIfAborted();
  return writeFullCiStamp(integrity.commonGitDir, stamp);
}

export async function writeVerifiedQuickCiReceipt(
  repoRoot: string,
  integrity: RepositoryIntegritySnapshot,
  receipt: Omit<QuickCiReceipt, "schemaVersion" | "gateVersion">,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  await assertRepositoryIntegrity(repoRoot, integrity, signal);
  signal.throwIfAborted();
  return writeQuickCiReceipt(integrity.commonGitDir, receipt);
}

export function assertCleanWorktree(repoRoot: string): void {
  const status = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(`Working tree must be clean for local CI.\n${status}`);
  }
}

async function assertCleanWorktreeWithCancellation(
  repoRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const status = await runGitWithCancellation(
    repoRoot,
    ["status", "--porcelain", "--untracked-files=all"],
    signal,
  );
  if (status) {
    throw new Error(`Working tree must be clean for local CI.\n${status}`);
  }
}

export function assertBaseIsAncestor(
  repoRoot: string,
  baseCommit: string,
  commit: string,
  baseRef = LASTCODE_BASE_BRANCH,
): void {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", baseCommit, commit],
    { cwd: repoRoot, env: cleanGitEnvironment(process.env), stdio: "ignore" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Current branch is not based on ${baseRef} at ${baseCommit}. Rebase it before running local CI.`,
    );
  }
}

function printPlan(mode: LocalCiMode, steps: ReadonlyArray<LocalCiStep>): void {
  console.log(`[lastcode:ci] ${mode} local CI plan:`);
  for (const step of steps) {
    const command =
      step.kind === "command"
        ? `: ${step.command} ${step.args.join(" ")}`
        : step.kind === "diff-whitespace"
          ? `: git diff --check <base>...<head>`
          : "";
    console.log(`- ${step.label}${command}`);
  }
}

async function executeLocalCi(
  options: LocalCiOptions,
  repoRoot: string,
  policy: LastCodeLocalCiSettings,
  repositoryIntegrity: RepositoryIntegritySnapshot,
  signal: AbortSignal,
  prePushUpdates?: ReadonlyArray<PrePushUpdate>,
): Promise<void> {
  await assertCleanWorktreeWithCancellation(repoRoot, signal);
  const commitBefore = runGit(repoRoot, ["rev-parse", "HEAD"]);
  let baseCommit: string | undefined;
  let quickBase: QuickCiBase | undefined;
  let checkpointContext: Extract<FullCiStamp["context"], { kind: "checkpoint" }> | undefined;
  if (options.mode === "full") {
    if (options.checkpointTag) {
      const installable = parseLastCodeInstallableTag(options.checkpointTag);
      if (!installable)
        throw new Error(`Invalid LastCode installable tag '${options.checkpointTag}'.`);
      const upstreamTag = installable.nightly.tag;
      const checkpointCommit = runGit(repoRoot, ["rev-parse", `${options.checkpointTag}^{commit}`]);
      if (checkpointCommit !== commitBefore) {
        throw new Error(
          `HEAD ${commitBefore} does not match checkpoint ${options.checkpointTag} at ${checkpointCommit}.`,
        );
      }
      const upstreamCommit = runGit(repoRoot, ["rev-parse", `${upstreamTag}^{commit}`]);
      assertBaseIsAncestor(repoRoot, upstreamCommit, commitBefore);
      checkpointContext = {
        kind: "checkpoint",
        checkpointTag: options.checkpointTag,
        upstreamCommit,
        upstreamTag,
      };
    } else {
      runProcess(repoRoot, "git", ["fetch", LASTCODE_ORIGIN_REMOTE, LASTCODE_BASE_BRANCH]);
      baseCommit = runGit(repoRoot, [
        "rev-parse",
        `refs/remotes/${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH}`,
      ]);
      assertBaseIsAncestor(repoRoot, baseCommit, commitBefore);
    }
  } else {
    const branchName = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    quickBase = resolveQuickCiBase(branchName);
    if (!options.prePush) {
      runProcess(repoRoot, "git", ["fetch", quickBase.remote, quickBase.branch]);
    }
    baseCommit = runGit(repoRoot, ["rev-parse", quickBase.remoteRef]);
    assertBaseIsAncestor(
      repoRoot,
      baseCommit,
      commitBefore,
      `${quickBase.remote}/${quickBase.branch}`,
    );

    if (options.prePush) {
      if (!prePushUpdates) throw new Error("Missing pre-push ref updates.");
      assertPrePushTargetsHead(prePushUpdates, commitBefore);
    }
  }

  const reuseReceipt = async () => {
    signal.throwIfAborted();
    await assertCleanWorktreeWithCancellation(repoRoot, signal);
    if ((await runGitWithCancellation(repoRoot, ["rev-parse", "HEAD"], signal)) !== commitBefore) {
      throw new Error("HEAD changed before local CI receipt reuse. Run Quick CI again.");
    }
    if (
      quickBase &&
      (await runGitWithCancellation(repoRoot, ["rev-parse", quickBase.remoteRef], signal)) !==
        baseCommit
    ) {
      throw new Error("The Quick CI base changed before receipt reuse. Run Quick CI again.");
    }
    if (
      quickBase &&
      baseCommit &&
      hasMatchingQuickCiReceipt(
        repositoryIntegrity.commonGitDir,
        commitBefore,
        baseCommit,
        quickBase.remoteRef,
      )
    ) {
      await assertRepositoryIntegrity(repoRoot, repositoryIntegrity, signal);
      signal.throwIfAborted();
      console.log(
        `[lastcode:ci] Reusing Quick CI receipt for ${commitBefore} against ${baseCommit}.`,
      );
      console.log(formatLocalCiSummary("quick", commitBefore, baseCommit));
      lastCodeAction.result({
        outcome: "success",
        summary: `Reused Quick CI for ${commitBefore}`,
        subject: { type: "commit", id: commitBefore, revision: commitBefore },
        facts: { mode: "quick", baseCommit, reused: "true" },
      });
      return true;
    }
    return false;
  };
  // Git operations above block the event loop. Dispatch a pending signal before
  // treating a cached receipt as a successful run.
  await NodeTimersPromises.setImmediate();
  signal.throwIfAborted();
  if (await reuseReceipt()) return;

  const quickCiMode =
    options.mode === "full" || options.requireLocal ? "local" : policy.quickCiMode;
  const deferToGitHub = async (reason: "configured" | "busy") => {
    await assertRepositoryIntegrity(repoRoot, repositoryIntegrity, signal);
    await assertCleanWorktreeWithCancellation(repoRoot, signal);
    if ((await runGitWithCancellation(repoRoot, ["rev-parse", "HEAD"], signal)) !== commitBefore) {
      throw new Error("HEAD changed before deferring Quick CI. Try the push again.");
    }
    if (
      quickBase &&
      (await runGitWithCancellation(repoRoot, ["rev-parse", quickBase.remoteRef], signal)) !==
        baseCommit
    ) {
      throw new Error("The Quick CI base changed before deferral. Try the push again.");
    }
    signal.throwIfAborted();
    const summary =
      reason === "busy"
        ? "Local CI capacity is busy; deferring Quick CI to required GitHub checks."
        : "GitHub-only mode selected; local Quick CI is optional.";
    console.log(`[lastcode:ci] Summary: ${summary}`);
    lastCodeAction.result({
      outcome: "attention",
      reason: "github-ci-required",
      summary,
      subject: { type: "commit", id: commitBefore, revision: commitBefore },
      facts: {
        mode: "quick",
        baseCommit: baseCommit!,
        validation: "github-only",
        skipReason: reason,
      },
    });
  };
  if (quickCiMode === "github") {
    await deferToGitHub("configured");
    return;
  }
  const budgetOptions = {
    policy,
    repoRoot,
    signal,
    onWaiting: (summary: string) => {
      console.log(`[lastcode:ci] ${summary}`);
      lastCodeAction.progress({ state: "waiting", phase: "ci-budget", summary });
    },
  };
  const lease =
    quickCiMode === "auto"
      ? await tryAcquireLocalCiBudget(budgetOptions)
      : await acquireLocalCiBudget(budgetOptions);
  if (lease === undefined) {
    await deferToGitHub("busy");
    return;
  }
  try {
    signal.throwIfAborted();
    await assertCleanWorktreeWithCancellation(repoRoot, signal);
    if ((await runGitWithCancellation(repoRoot, ["rev-parse", "HEAD"], signal)) !== commitBefore) {
      throw new Error("HEAD changed while waiting for local CI capacity. Run Quick CI again.");
    }
    if (
      quickBase &&
      (await runGitWithCancellation(repoRoot, ["rev-parse", quickBase.remoteRef], signal)) !==
        baseCommit
    ) {
      throw new Error("The Quick CI base changed while waiting for capacity. Run Quick CI again.");
    }
    // Another invocation may have completed this exact validation while we queued.
    if (await reuseReceipt()) return;
    if (policy.backgroundPriority) NodeOS.setPriority(0, NodeOS.constants.priority.PRIORITY_LOW);
    const scope =
      quickBase && baseCommit ? resolveQuickCiScope(repoRoot, baseCommit, commitBefore) : undefined;
    if (scope) console.log(`[lastcode:ci] Typecheck scope: ${scope.kind} (${scope.reason}).`);
    const steps = resolveLocalCiSteps(options.mode, scope, policy, repoRoot);
    await NodeTimersPromises.setImmediate();
    signal.throwIfAborted();

    const transferOutputDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-local-ci-"),
    );
    const isolatedGitConfigPath = NodePath.join(transferOutputDirectory, "gitconfig");
    const rustToolchainBin =
      options.mode === "full"
        ? NodePath.dirname(
            runProcess(repoRoot, "rustup", ["which", "cargo", "--toolchain", "stable"], {
              capture: true,
            }),
          )
        : undefined;
    NodeFS.writeFileSync(
      isolatedGitConfigPath,
      [
        "[user]",
        "\tname = LastCode Local CI",
        "\temail = local-ci@lastcode.invalid",
        "[init]",
        "\tdefaultBranch = main",
        "",
      ].join("\n"),
    );
    try {
      for (const [index, step] of steps.entries()) {
        signal.throwIfAborted();
        console.log(`\n[lastcode:ci] ${index + 1}/${steps.length} ${step.label}`);
        lastCodeAction.progress({
          state: "working",
          phase: step.kind,
          summary: step.label,
          current: index + 1,
          total: steps.length,
          unit: "step",
        });
        if (step.kind === "verify-preload") {
          verifyPreloadBundle(repoRoot);
          continue;
        }
        if (step.kind === "diff-whitespace") {
          runProcess(repoRoot, "git", ["diff", "--check", `${baseCommit!}...${commitBefore}`]);
          continue;
        }

        const env = {
          ...process.env,
          ...(step.isolatedGitConfig
            ? {
                GIT_CONFIG_GLOBAL: isolatedGitConfigPath,
                GIT_CONFIG_NOSYSTEM: "1",
              }
            : {}),
          ...(step.rustToolchainPath && rustToolchainBin
            ? { PATH: `${rustToolchainBin}${NodePath.delimiter}${process.env.PATH ?? ""}` }
            : {}),
          ...(step.transferBudgetOutput
            ? {
                T3CODE_TRANSFER_BUDGET_REPORT_PATH: NodePath.join(
                  transferOutputDirectory,
                  "t3code-transfer-budget.md",
                ),
                T3CODE_TRANSFER_BUDGET_RESULT_PATH: NodePath.join(
                  transferOutputDirectory,
                  "thread-transfer-result.json",
                ),
              }
            : {}),
        };
        const inheritedEnv = cleanGitEnvironment(env);
        await runCiProcess({
          cwd: repoRoot,
          command: step.command,
          args: step.args,
          signal,
          onSpawn: (pid) => lease.recordChild(pid),
          env: {
            ...inheritedEnv,
            GOMAXPROCS: String(policy.compilerThreads),
            PATH: `${NodePath.resolve(repoRoot, "node_modules/.bin")}${NodePath.delimiter}${inheritedEnv.PATH ?? ""}`,
          },
          ...(step.failureHelp ? { failureHelp: step.failureHelp } : {}),
        });
      }
    } finally {
      NodeFS.rmSync(transferOutputDirectory, { recursive: true, force: true });
    }

    // Synchronous scope/Git-only runs must also dispatch pending cancellation
    // before publishing success. Revalidate the checkout after yielding.
    await NodeTimersPromises.setImmediate();
    signal.throwIfAborted();
    const commitAfter = await runGitWithCancellation(repoRoot, ["rev-parse", "HEAD"], signal);
    if (commitAfter !== commitBefore) {
      throw new Error(`HEAD changed during local CI (${commitBefore} -> ${commitAfter}).`);
    }
    await assertCleanWorktreeWithCancellation(repoRoot, signal);
    if (
      quickBase &&
      (await runGitWithCancellation(repoRoot, ["rev-parse", quickBase.remoteRef], signal)) !==
        baseCommit
    ) {
      throw new Error("The Quick CI base changed during validation. Run Quick CI again.");
    }

    // Verify all owned checks have stopped, but keep capacity until the receipt
    // is published so a queued invocation can reuse the completed validation.
    lease.recordChild(undefined);

    if (options.mode === "full" && (baseCommit || checkpointContext)) {
      const stampPath = await writeVerifiedFullCiStamp(
        repoRoot,
        repositoryIntegrity,
        {
          commit: commitBefore,
          completedAt: new Date().toISOString(),
          context: checkpointContext ?? {
            kind: "pull-request",
            baseCommit: baseCommit!,
            baseRef: LASTCODE_BASE_BRANCH,
          },
        },
        signal,
      );
      lease.release();
      console.log(`\n[lastcode:ci] Full local CI passed for ${commitBefore}.`);
      console.log(`[lastcode:ci] Stamp: ${stampPath}`);
      console.log(formatLocalCiSummary("full", commitBefore));
      lastCodeAction.result({
        outcome: "success",
        summary: `Full local CI passed for ${commitBefore}`,
        subject: { type: "commit", id: commitBefore, revision: commitBefore },
        facts: { mode: "full" },
      });
    } else if (options.mode === "quick" && baseCommit && quickBase) {
      const receiptPath = await writeVerifiedQuickCiReceipt(
        repoRoot,
        repositoryIntegrity,
        {
          commit: commitBefore,
          baseCommit,
          baseRef: quickBase.remoteRef,
          completedAt: new Date().toISOString(),
        },
        signal,
      );
      lease.release();
      console.log(`\n[lastcode:ci] Quick local CI passed for ${commitBefore}.`);
      console.log(`[lastcode:ci] Receipt: ${receiptPath}`);
      console.log(formatLocalCiSummary("quick", commitBefore, baseCommit));
      lastCodeAction.result({
        outcome: "success",
        summary: `Quick local CI passed for ${commitBefore}`,
        subject: { type: "commit", id: commitBefore, revision: commitBefore },
        facts: { mode: "quick", baseCommit },
      });
    }
  } finally {
    lease.release();
  }
}

async function runLocalCi(options: LocalCiOptions): Promise<void> {
  const prePushUpdates = options.prePush
    ? parsePrePushUpdates(NodeFS.readFileSync(0, "utf8"))
    : undefined;
  if (prePushUpdates && !hasPrePushBranchCommit(prePushUpdates)) {
    console.log("[lastcode:ci] No pushed branch commit requires Quick CI.");
    return;
  }
  assertSupportedNodeVersion();
  const { integrity: repositoryIntegrity, repoRoot } = prepareLocalCiRepository();
  const policy = await readLocalCiPolicy();
  if (options.dryRun) {
    let scope: QuickCiScope | undefined;
    if (options.mode === "quick") {
      const base = resolveQuickCiBase(
        runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      );
      scope = resolveQuickCiScope(
        repoRoot,
        runGit(repoRoot, ["rev-parse", base.remoteRef]),
        runGit(repoRoot, ["rev-parse", "HEAD"]),
      );
      console.log(`[lastcode:ci] Typecheck scope: ${scope.kind} (${scope.reason}).`);
    }
    printPlan(options.mode, resolveLocalCiSteps(options.mode, scope, policy, repoRoot));
    return;
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Local CI cancelled."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await executeLocalCi(
      options,
      repoRoot,
      policy,
      repositoryIntegrity,
      controller.signal,
      prePushUpdates,
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await assertRepositoryIntegrity(repoRoot, repositoryIntegrity);
  }
}

if (import.meta.main) {
  try {
    await runLocalCi(parseLocalCiOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(formatLocalCiFailureSummary(error));
    process.exitCode = 1;
  }
}
