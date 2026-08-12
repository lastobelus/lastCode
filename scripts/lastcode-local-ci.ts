#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Host-side CI orchestration runs subprocesses directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { cleanGitEnvironment, nightlyTagFromCheckpointTag } from "./lastcode-nightly.ts";

export const LASTCODE_BASE_BRANCH = "lastcode/main";
export const LASTCODE_ORIGIN_REMOTE = "origin";

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

export type LocalCiStep = CommandStep | VerifyPreloadStep;

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
  readonly checkpointTag?: string;
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
    args: ["run", "test"],
    isolatedGitConfig: true,
    transferBudgetOutput: true,
  },
];

const FULL_ONLY_STEPS: ReadonlyArray<LocalCiStep> = [
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
    command: "brew",
    args: ["bundle", "check", "--file", "apps/mobile/Brewfile"],
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
  let checkpointTag: string | undefined;

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
    } else if (arg === "--checkpoint") {
      checkpointTag = argv[index + 1];
      if (!checkpointTag) throw new Error("Missing value for --checkpoint.");
      index += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }

  return { mode, dryRun, ...(checkpointTag ? { checkpointTag } : {}) };
}

export function resolveLocalCiSteps(mode: LocalCiMode): ReadonlyArray<LocalCiStep> {
  return mode === "quick" ? QUICK_STEPS : [...QUICK_STEPS, ...FULL_ONLY_STEPS];
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
      `Checkpoint ${checkpointTag} at ${commit} has not passed full local CI. Run: pnpm lastcode:ci --checkpoint ${checkpointTag}`,
    );
  }
  if (
    stamp.context.kind !== "checkpoint" ||
    stamp.context.checkpointTag !== checkpointTag ||
    stamp.context.upstreamCommit !== upstreamCommit
  ) {
    throw new Error(
      `Full local CI stamp for ${commit} does not match checkpoint ${checkpointTag}. Rerun: pnpm lastcode:ci --checkpoint ${checkpointTag}`,
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

export function resolveRepoRoot(cwd = process.cwd()): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function resolveCommonGitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export function assertCleanWorktree(repoRoot: string): void {
  const status = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(`Working tree must be clean for full local CI.\n${status}`);
  }
}

export function assertBaseIsAncestor(repoRoot: string, baseCommit: string, commit: string): void {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", baseCommit, commit],
    { cwd: repoRoot, env: cleanGitEnvironment(process.env), stdio: "ignore" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Current branch is not based on the latest ${LASTCODE_BASE_BRANCH}. Rebase it before running full local CI.`,
    );
  }
}

function printPlan(mode: LocalCiMode): void {
  console.log(`[lastcode:ci] ${mode} local CI plan:`);
  for (const step of resolveLocalCiSteps(mode)) {
    const command = step.kind === "command" ? `: ${step.command} ${step.args.join(" ")}` : "";
    console.log(`- ${step.label}${command}`);
  }
}

function runLocalCi(options: LocalCiOptions): void {
  assertSupportedNodeVersion();
  const repoRoot = resolveRepoRoot();
  const steps = resolveLocalCiSteps(options.mode);

  if (options.dryRun) {
    printPlan(options.mode);
    return;
  }

  let commitBefore: string | undefined;
  let baseCommit: string | undefined;
  let checkpointContext: Extract<FullCiStamp["context"], { kind: "checkpoint" }> | undefined;
  if (options.mode === "full") {
    assertCleanWorktree(repoRoot);
    commitBefore = runGit(repoRoot, ["rev-parse", "HEAD"]);
    if (options.checkpointTag) {
      const upstreamTag = nightlyTagFromCheckpointTag(options.checkpointTag);
      if (!upstreamTag)
        throw new Error(`Invalid LastCode checkpoint tag '${options.checkpointTag}'.`);
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
  }

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
      console.log(`\n[lastcode:ci] ${index + 1}/${steps.length} ${step.label}`);
      if (step.kind === "verify-preload") {
        verifyPreloadBundle(repoRoot);
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
      runProcess(repoRoot, step.command, step.args, {
        env,
        ...(step.failureHelp ? { failureHelp: step.failureHelp } : {}),
      });
    }
  } finally {
    NodeFS.rmSync(transferOutputDirectory, { recursive: true, force: true });
  }

  if (options.mode === "full" && commitBefore && (baseCommit || checkpointContext)) {
    const commitAfter = runGit(repoRoot, ["rev-parse", "HEAD"]);
    if (commitAfter !== commitBefore) {
      throw new Error(`HEAD changed during local CI (${commitBefore} -> ${commitAfter}).`);
    }
    assertCleanWorktree(repoRoot);
    const stampPath = writeFullCiStamp(resolveCommonGitDir(repoRoot), {
      commit: commitBefore,
      completedAt: new Date().toISOString(),
      context: checkpointContext ?? {
        kind: "pull-request",
        baseCommit: baseCommit!,
        baseRef: LASTCODE_BASE_BRANCH,
      },
    });
    console.log(`\n[lastcode:ci] Full local CI passed for ${commitBefore}.`);
    console.log(`[lastcode:ci] Stamp: ${stampPath}`);
  } else {
    console.log("\n[lastcode:ci] Quick local CI passed.");
  }
}

if (import.meta.main) {
  try {
    runLocalCi(parseLocalCiOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`[lastcode:ci] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
