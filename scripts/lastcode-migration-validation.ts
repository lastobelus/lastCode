// @effect-diagnostics nodeBuiltinImport:off -- Release validation runs against exact Git checkouts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assertMigrationHistory } from "./lastcode-migration-history.ts";
import { compareLastCodeInstallableTags, parseLastCodeInstallableTag } from "./lastcode-nightly.ts";

const installedWorktrees = new Set<string>();
export function migrationDependenciesInstalled(worktree: string): void {
  installedWorktrees.add(worktree);
}

function run(cwd: string, command: string, args: string[]): string {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
  }).trim();
}

/** Every installable publication and package validates the exact candidate independently of smoke. */
export function validateInstallableMigrations(input: {
  readonly repoRoot: string;
  readonly candidateRef: string;
  readonly upstreamRef: string;
  readonly installableTag: string;
  readonly sourceRef?: string;
}): void {
  const { repoRoot } = input;
  const upstreamRef = run(repoRoot, "git", ["rev-parse", `${input.upstreamRef}^{commit}`]);
  const candidateRef = run(repoRoot, "git", ["rev-parse", `${input.candidateRef}^{commit}`]);
  const target = parseLastCodeInstallableTag(input.installableTag)!;
  const previous = run(repoRoot, "git", [
    "tag",
    "--list",
    "lastcode/checkpoint/*",
    "lastcode/revision/*",
  ])
    .split(/\r?\n/)
    .flatMap((tag) => {
      const parsed = parseLastCodeInstallableTag(tag);
      return parsed ? [parsed] : [];
    })
    .filter((tag) => compareLastCodeInstallableTags(tag, target) < 0)
    .sort(compareLastCodeInstallableTags)
    .at(-1)?.tag;
  for (const previousRef of new Set([previous, input.sourceRef])) {
    assertMigrationHistory({
      repoRoot,
      candidateRef,
      upstreamRef,
      ...(previousRef ? { previousRef } : {}),
    });
  }
  const worktrees = run(repoRoot, "git", ["worktree", "list", "--porcelain"]);
  let checkout = worktrees
    .split("\n\n")
    .flatMap((entry) => {
      const lines = entry.split("\n");
      return lines.includes(`HEAD ${candidateRef}`) && lines[0]?.startsWith("worktree ")
        ? [lines[0].slice("worktree ".length)]
        : [];
    })
    .find((path) => run(path, "git", ["status", "--porcelain", "--untracked-files=all"]) === "");
  let disposable: string | undefined;
  if (!checkout) {
    const common = run(repoRoot, "git", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    disposable = NodeFS.mkdtempSync(NodePath.join(common, "migration-validation-"));
    checkout = NodePath.join(disposable, "checkout");
    run(repoRoot, "git", ["worktree", "add", "--detach", checkout, candidateRef]);
  }
  try {
    if (!installedWorktrees.has(checkout)) {
      run(checkout, NodePath.join(repoRoot, "node_modules/.bin/vp"), [
        "install",
        "--frozen-lockfile",
      ]);
    }
    run(checkout, NodePath.join(checkout, "node_modules/.bin/vp"), [
      "test",
      "run",
      "apps/server/src/persistence/DatabaseMigrations.test.ts",
    ]);
    if (
      run(checkout, "git", ["rev-parse", "HEAD"]) !== candidateRef ||
      run(checkout, "git", ["status", "--porcelain", "--untracked-files=all"])
    ) {
      throw new Error("Migration validation changed the candidate checkout; refusing publication.");
    }
  } finally {
    if (disposable) {
      run(repoRoot, "git", ["worktree", "remove", "--force", checkout]);
      NodeFS.rmSync(disposable, { recursive: true, force: true });
    }
  }
}
