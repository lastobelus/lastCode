// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - worktrees start without dependencies.
/** Link the main checkout's ignored env files; prepare dependencies separately. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = process.cwd();

// Worktrees link main-checkout env files; replace only symlinks so real files always survive.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (source === target) continue;
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

console.log("[setup-worktree] Environment files linked. Dependencies are deferred until needed.");
