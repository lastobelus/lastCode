#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Completed-tree recovery uses host Git and pnpm.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { prepareDependencies, verifyPnpmVersion } from "./prepare-dependencies.ts";

export async function regenerateCheckpointLockfile(upstream: string, cwd: string) {
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  for (const state of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (NodeFS.existsSync(NodePath.resolve(cwd, git("rev-parse", "--git-path", state)))) {
      throw new Error("Finish the replay and resolve conflicts before regenerating derived files.");
    }
  }
  if (git("diff", "--name-only", "--diff-filter=U")) {
    throw new Error("Resolve all unmerged paths before regenerating derived files.");
  }
  const commit = git("rev-parse", "--verify", `${upstream}^{commit}`);
  const lockfile = NodeChildProcess.execFileSync("git", ["show", `${commit}:pnpm-lock.yaml`], {
    cwd,
  });
  verifyPnpmVersion(cwd);
  NodeFS.writeFileSync(NodePath.resolve(cwd, "pnpm-lock.yaml"), lockfile);
  NodeChildProcess.execFileSync(
    "pnpm",
    ["install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts"],
    {
      cwd,
      stdio: "inherit",
    },
  );
  // Frozen installation checks every completed manifest (including fork-only versions),
  // verifies patch contents, and supplies the completed tree's dependencies to the generator.
  prepareDependencies(cwd);
  const { parseAllDocuments } = await import("yaml");
  const { verifyDerivedLockfile, parseWorkspaceLockfile } =
    await import("./lib/lastcode-derived-lockfile.ts");
  const settings = parseAllDocuments(
    NodeFS.readFileSync(NodePath.resolve(cwd, "pnpm-workspace.yaml"), "utf8"),
  )[0]!.toJS();
  const regenerated = parseWorkspaceLockfile(
    NodeFS.readFileSync(NodePath.resolve(cwd, "pnpm-lock.yaml"), "utf8"),
  );
  verifyDerivedLockfile(settings, regenerated);
  return commit;
}

async function regenerateDerived(upstream: string, cwd: string) {
  const commit = await regenerateCheckpointLockfile(upstream, cwd);
  NodeChildProcess.execFileSync("pnpm", ["--dir", "apps/server", "agent-context:generate"], {
    cwd,
    stdio: "inherit",
  });
  console.log(
    `Regenerated lockfile from ${commit}; frozen install, overrides, patches and context budget passed.`,
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--upstream" || !args[1]) {
    throw new Error("Usage: pnpm lastcode:regenerate-derived --upstream <target-upstream-commit>");
  }
  await regenerateDerived(args[1], process.cwd());
}
