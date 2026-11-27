// @effect-diagnostics nodeBuiltinImport:off -- Shared with dependency-free preparation before packages are installed.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const RECENT_DEPENDENCY_USAGE_SKIP_MS = DAY_MS;

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
  let previous: { identity: string; lastUsedAt: number; verifiedUseAt: number | null } | null =
    null;
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
    let verifiedUseAt: number | null = null;
    if ("verifiedUseAt" in value) {
      if (
        typeof value.verifiedUseAt !== "number" ||
        !Number.isSafeInteger(value.verifiedUseAt) ||
        value.verifiedUseAt < 0 ||
        value.verifiedUseAt > value.lastUsedAt
      ) {
        throw new Error("Invalid dependency activity record");
      }
      verifiedUseAt = value.verifiedUseAt;
    }
    previous = { identity: value.identity, lastUsedAt: value.lastUsedAt, verifiedUseAt };
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
  const sameIdentity = previous !== null && previous.identity === identity;
  const renewed = used || !sameIdentity;
  const lastUsedAt = renewed
    ? Math.max(now, previous?.lastUsedAt ?? 0)
    : (previous?.lastUsedAt ?? now);
  // Tracks any use observation that renews lastUsedAt (not init or identity change); a false positive costs at most the 24h shift without affecting removal safety.
  const verifiedUseAt = used
    ? Math.max(now, sameIdentity ? (previous.verifiedUseAt ?? 0) : 0)
    : sameIdentity
      ? previous.verifiedUseAt
      : null;
  if (persist && renewed) {
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(
        temporary,
        JSON.stringify(
          verifiedUseAt === null
            ? { version: 1, identity, lastUsedAt }
            : { version: 1, identity, lastUsedAt, verifiedUseAt },
        ),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      NodeFS.renameSync(temporary, target);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
  return { lastUsedAt, renewed };
}

/** Read the established clock for this install when current usage is unknown. */
export function knownDependencyActivity(gitDirectory: string, worktreePath: string) {
  const { identity, previous } = readActivity(gitDirectory, worktreePath);
  return previous?.identity === identity
    ? { lastUsedAt: previous.lastUsedAt, renewed: false }
    : null;
}

/** Skip only inside 24h after verified use of this same install while inside retention. */
export function recentVerifiedDependencyActivity(
  gitDirectory: string,
  worktreePath: string,
  now: number,
  retentionDays: number,
): { readonly lastUsedAt: number; readonly renewed: false } | null {
  const { identity, previous } = readActivity(gitDirectory, worktreePath);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid observation time");
  if (
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0 ||
    previous === null ||
    previous.identity !== identity ||
    previous.verifiedUseAt === null ||
    previous.verifiedUseAt > now ||
    previous.lastUsedAt > now ||
    previous.lastUsedAt <= now - retentionDays * DAY_MS ||
    now - previous.verifiedUseAt >= RECENT_DEPENDENCY_USAGE_SKIP_MS
  ) {
    return null;
  }
  return { lastUsedAt: previous.lastUsedAt, renewed: false };
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
