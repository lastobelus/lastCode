// @effect-diagnostics nodeBuiltinImport:off -- Host-side Git helpers shared by local CI and the guarded merge.
// No installed dependencies: lastcode:merge runs from checkouts without node_modules.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CiCommandFailure } from "./lastcode-ci-process.ts";

export const LASTCODE_BASE_BRANCH = "lastcode/main";
export const LASTCODE_ORIGIN_REMOTE = "origin";

const GIT_LOCAL_ENVIRONMENT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

export function cleanGitEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !GIT_LOCAL_ENVIRONMENT_VARIABLES.has(entry[0]),
    ),
  );
}

const PROJECT_NODE_VERSION: string = JSON.parse(
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
).engines.node;

// Transition: saved Project Actions in Settings still launch through `mise exec node@24.13.1`.
// Remove the ^24.13.1 branch once they launch with the `engines.node` version.
function isTransitionalNode24(major: number, minor: number, patch: number): boolean {
  return major === 24 && (minor > 13 || (minor === 13 && patch >= 1));
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (version === PROJECT_NODE_VERSION || isTransitionalNode24(major, minor, patch)) return;
  throw new Error(
    `LastCode local CI requires Node ${PROJECT_NODE_VERSION} (root package.json engines.node) or ^24.13.1, received ${version}. Run it through the package script so mise selects the project runtime.`,
  );
}

export function runProcess(
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
    throw new CiCommandFailure(details.join("\n"));
  }

  return options.capture ? result.stdout.trim() : "";
}

export function runGit(repoRoot: string, args: ReadonlyArray<string>): string {
  return runProcess(repoRoot, "git", args, { capture: true });
}

export function resolveRepoRoot(cwd = process.cwd()): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function assertCleanWorktree(repoRoot: string): void {
  const status = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
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
