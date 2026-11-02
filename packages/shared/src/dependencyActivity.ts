// @effect-diagnostics nodeBuiltinImport:off -- Shared with dependency-free preparation before packages are installed.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const readActivity = (gitDirectory: string, worktreePath: string) => {
  const gitDir = NodeFS.realpathSync(gitDirectory);
  const cwd = NodeFS.realpathSync(worktreePath);
  const dependencyPath = NodePath.join(cwd, "node_modules");
  const directory = NodeFS.lstatSync(dependencyPath);
  if (!directory.isDirectory()) throw new Error("Dependencies are not a real directory");
  const signatures = [
    cwd,
    dependencyPath,
    ...[".modules.yaml", ".package-lock.json"].map((name) => NodePath.join(dependencyPath, name)),
  ].map((target) => {
    let stat;
    try {
      stat = NodeFS.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Linked dependency activity identity");
    // Include marker changes so direct package-manager preparation also renews age.
    return [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs];
  });
  // Folder timestamps aren't usage. Only replacement and installer marker changes renew age.
  signatures[0] = signatures[0]!.slice(0, 3);
  signatures[1] = signatures[1]!.slice(0, 3);
  const identity = JSON.stringify({ cwd, signatures });
  const target = NodePath.join(gitDir, "t3-dependency-activity.json");
  let recordIdentity: readonly number[] | null = null;
  let previous: { identity: string; lastUsedAt: number } | null = null;
  try {
    const stat = NodeFS.lstatSync(target);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Unsafe dependency activity record");
    recordIdentity = [stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs];
    const value: unknown = JSON.parse(NodeFS.readFileSync(target, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("identity" in value) ||
      typeof value.identity !== "string" ||
      !("lastUsedAt" in value) ||
      typeof value.lastUsedAt !== "number" ||
      !Number.isSafeInteger(value.lastUsedAt) ||
      value.lastUsedAt < 0
    ) {
      throw new Error("Invalid dependency activity record");
    }
    previous = { identity: value.identity, lastUsedAt: value.lastUsedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { identity, target, previous, recordIdentity };
};

/** Usage evidence only: this record conveys neither install integrity nor deletion consent. */
export function observeDependencyActivity(
  gitDirectory: string,
  worktreePath: string,
  now: number,
  used = false,
  persist = true,
) {
  const { identity, target, previous } = readActivity(gitDirectory, worktreePath);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid observation time");
  const renewed = used || previous === null || previous.identity !== identity;
  const lastUsedAt = renewed
    ? Math.max(now, previous?.lastUsedAt ?? 0)
    : (previous?.lastUsedAt ?? now);
  if (persist && renewed) {
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(temporary, JSON.stringify({ version: 1, identity, lastUsedAt }), {
        flag: "wx",
        mode: 0o600,
      });
      NodeFS.renameSync(temporary, target);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
  return { lastUsedAt, renewed };
}

const worktreeGitDirectory = (cwd: string) => {
  const target = NodePath.join(cwd, ".git");
  const stat = NodeFS.lstatSync(target);
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid linked-worktree metadata");
  const contents = NodeFS.readFileSync(target, "utf8").trim();
  if (!contents.startsWith("gitdir: ") || contents.includes("\n"))
    throw new Error("Invalid linked-worktree metadata");
  return NodePath.resolve(cwd, contents.slice(8));
};

/** A read-only comparison immediately before removal catches in-place renewal too. */
export function dependencyActivitySnapshot(worktreePath: string) {
  const cwd = NodeFS.realpathSync(worktreePath);
  const { identity, target, previous, recordIdentity } = readActivity(
    worktreeGitDirectory(cwd),
    cwd,
  );
  return JSON.stringify({ identity, target, previous, recordIdentity });
}

/** Record actual dependency-backed execution, including commands below the checkout root. */
export function recordDependencyUse(startDirectory: string, now: number) {
  let cwd = NodeFS.realpathSync(startDirectory);
  for (let depth = 0; depth < 64; depth++) {
    const gitFile = NodePath.join(cwd, ".git");
    let stat;
    try {
      stat = NodeFS.lstatSync(gitFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat !== undefined) {
      if (!stat.isFile() || stat.size > 4096) return;
      if (!NodeFS.existsSync(NodePath.join(cwd, "node_modules"))) return;
      observeDependencyActivity(worktreeGitDirectory(cwd), cwd, now, true);
      return;
    }
    const parent = NodePath.dirname(cwd);
    if (parent === cwd) return;
    cwd = parent;
  }
}
