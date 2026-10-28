// @effect-diagnostics nodeBuiltinImport:off -- Also used by dependency-free build runners.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  acquirePortableLock,
  PortableLockContentionError,
} from "../../../scripts/lastcode-lock.mjs";

type OwnedFile = { path: string; identity: string; hash: string; bytes: number };
type BuildRecord = {
  version: 1;
  worktreeIdentity: string;
  root: string;
  lastUsedAt: number;
  files: OwnedFile[];
  emissions: Array<{ path: string; hash: string }>;
};
const MAX_FILES = 50_000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const signature = (stat: NodeFS.Stats) =>
  JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs, stat.size]);
const allocation = (stat: NodeFS.Stats) => JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const allowedRoot = (root: string) =>
  /^apps\/[a-zA-Z0-9_-]+\/dist$/.test(root) || root === "native/resource-monitor/target/debug";
const safeRelative = (path: string) =>
  path.length > 0 &&
  // oxlint-disable-next-line no-control-regex -- Reject control characters in emitted relative paths.
  !/[\\:\x00-\x1f]/.test(path) &&
  !NodePath.posix.isAbsolute(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function context(worktreePath: string, root: string) {
  if (!allowedRoot(root)) throw new Error("Unrecognized generated build root");
  const cwd = NodeFS.realpathSync(worktreePath);
  const gitFile = NodePath.join(cwd, ".git");
  let stat;
  try {
    stat = NodeFS.lstatSync(gitFile);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (stat.isDirectory()) return null;
  if (!stat.isFile() || stat.size > 4096) throw new Error("Unsafe worktree metadata");
  const contents = NodeFS.readFileSync(gitFile, "utf8").trim();
  if (!contents.startsWith("gitdir: ") || contents.includes("\n"))
    throw new Error("Invalid worktree metadata");
  const gitDir = NodeFS.realpathSync(NodePath.resolve(cwd, contents.slice(8)));
  const worktreeIdentity = `${cwd}:${allocation(NodeFS.lstatSync(cwd))}`;
  const recordPath = NodePath.join(
    gitDir,
    `t3-build-${NodeCrypto.createHash("sha256").update(root).digest("hex")}.json`,
  );
  return { cwd, gitDir, root, recordPath, worktreeIdentity };
}
type Context = NonNullable<ReturnType<typeof context>>;

function acquireBuildMutationLock(ctx: Context) {
  const name = `${NodePath.basename(ctx.recordPath)}.publish`;
  try {
    return acquirePortableLock(ctx.gitDir, name, "generated build update");
  } catch (error) {
    if (error instanceof PortableLockContentionError)
      throw new PortableLockContentionError(
        `${error.message} Retry after the current output operation finishes. If the owner is unknown, inspect ${NodePath.join(ctx.gitDir, name)} lock metadata before recovery; do not clear a live owner's lock.`,
        { cause: error },
      );
    throw error;
  }
}

function tryAcquireBuildMutationLock(ctx: Context) {
  try {
    return acquireBuildMutationLock(ctx);
  } catch (error) {
    if (error instanceof PortableLockContentionError) return null;
    throw error;
  }
}

/** Branding belongs to private compiler/release stages, never published managed output. */
export function assertUnpublishedGeneratedBuildTarget(directory: string) {
  const target = NodeFS.realpathSync(directory);
  let ancestor = target;
  while (true) {
    const relative = NodePath.relative(ancestor, target).split(NodePath.sep).join("/");
    if (/^apps\/[a-zA-Z0-9_-]+\/dist(?:\/|$)/.test(relative)) {
      let metadata;
      try {
        metadata = NodeFS.lstatSync(NodePath.join(ancestor, ".git"));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (metadata && !metadata.isDirectory())
        throw new Error("Branding managed output requires a fresh compiler or release stage");
    }
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

/** Every existing component must be a real directory; neither links nor files may redirect a build path. */
function safePath(base: string, relative: string) {
  if (!safeRelative(relative)) throw new Error("Unsafe generated file path");
  let ancestor = base;
  while (true) {
    try {
      const stat = NodeFS.lstatSync(ancestor);
      if (!stat.isDirectory() || NodeFS.realpathSync(ancestor) !== ancestor)
        throw new Error("Linked or invalid generated path");
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const parts = relative.split("/");
  let target = base;
  for (const [index, part] of parts.entries()) {
    target = NodePath.join(target, part);
    try {
      const stat = NodeFS.lstatSync(target);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        throw new Error("Linked or invalid generated path");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return target;
}
function fileEvidence(target: string, allowStageHardlinks = false) {
  const before = NodeFS.lstatSync(target);
  if (!before.isFile() || (!allowStageHardlinks && before.nlink !== 1))
    throw new Error("Generated output is not an exclusive regular file");
  const hash = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(target)).digest("hex");
  if (signature(NodeFS.lstatSync(target)) !== signature(before))
    throw new Error("Generated output changed during observation");
  return {
    identity: signature(before),
    hash,
    bytes: Number.isFinite(before.blocks) ? before.blocks * 512 : before.size,
    mode: before.mode,
  };
}
function readRecord(ctx: Context, allowPending = false) {
  if (!allowPending) assertNoPendingPublication(ctx);
  let stat;
  try {
    stat = NodeFS.lstatSync(ctx.recordPath);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES)
    throw new Error("Unsafe build ownership record");
  const raw = NodeFS.readFileSync(ctx.recordPath, "utf8");
  const value: unknown = JSON.parse(raw);
  validateRecord(ctx, value);
  if (signature(NodeFS.lstatSync(ctx.recordPath)) !== signature(stat))
    throw new Error("Build ownership changed during observation");
  return {
    record: value as BuildRecord,
    recordIdentity: signature(stat),
    token: NodeCrypto.createHash("sha256").update(raw).update(signature(stat)).digest("hex"),
  };
}
function validateRecord(ctx: Context, value: unknown): asserts value is BuildRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("worktreeIdentity" in value) ||
    value.worktreeIdentity !== ctx.worktreeIdentity ||
    !("root" in value) ||
    value.root !== ctx.root ||
    !("lastUsedAt" in value) ||
    typeof value.lastUsedAt !== "number" ||
    !Number.isSafeInteger(value.lastUsedAt) ||
    value.lastUsedAt < 0 ||
    !("emissions" in value) ||
    !Array.isArray(value.emissions) ||
    value.emissions.length > MAX_FILES ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_FILES
  )
    throw new Error("Invalid build ownership record");
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      !safeRelative(file.path) ||
      paths.has(file.path) ||
      typeof file.identity !== "string" ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    )
      throw new Error("Invalid owned build file");
    paths.add(file.path);
  }
  const emittedPaths = new Set<string>();
  for (const emission of value.emissions) {
    if (
      typeof emission !== "object" ||
      emission === null ||
      typeof emission.path !== "string" ||
      !safeRelative(emission.path) ||
      emittedPaths.has(emission.path) ||
      typeof emission.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(emission.hash)
    )
      throw new Error("Invalid compiler emission");
    emittedPaths.add(emission.path);
  }
}
const recordOwnership = (record: BuildRecord | null) =>
  record === null
    ? null
    : JSON.stringify({
        version: record.version,
        worktreeIdentity: record.worktreeIdentity,
        root: record.root,
        files: record.files,
        emissions: record.emissions,
      });
const ownershipSnapshot = (previous: ReturnType<typeof readRecord>) =>
  recordOwnership(previous?.record ?? null);

function flushPreparedFile(path: string) {
  const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0));
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function writeRecord(ctx: Context, record: BuildRecord, expectedIdentity?: string) {
  const raw = JSON.stringify(record);
  if (record.files.length > MAX_FILES || Buffer.byteLength(raw) > MAX_RECORD_BYTES)
    throw new Error("Build ownership exceeds its observation limit");
  const temporary = `${ctx.recordPath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
    flushPreparedFile(temporary);
    // Mutations hold the root lock; also reject an unexpected native record replacement.
    if (
      expectedIdentity !== undefined &&
      signature(NodeFS.lstatSync(ctx.recordPath)) !== expectedIdentity
    )
      return false;
    NodeFS.renameSync(temporary, ctx.recordPath);
    return true;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}
function evidenceMatches(file: OwnedFile, target: string) {
  const current = fileEvidence(target);
  return current.identity === file.identity && current.hash === file.hash;
}

type Publication = {
  version: 1;
  id: string;
  worktreeIdentity: string;
  root: string;
  phase: "preparing" | "installing" | "committed";
  previous: BuildRecord | null;
  nextOwnership: string | null;
  now: number;
  emissions: BuildRecord["emissions"];
  directories: Array<{ path: string; allocation: string }>;
  files: Array<{
    path: string;
    temporary: string;
    prior: OwnedFile | null;
    hash: string;
    mode: number;
    prepared: string | null;
  }>;
};
const pendingPath = (ctx: Context) => `${ctx.recordPath}.pending`;
function hasPendingPublication(ctx: Context) {
  try {
    NodeFS.lstatSync(pendingPath(ctx));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function assertNoPendingPublication(ctx: Context) {
  if (hasPendingPublication(ctx)) throw new Error("Build publication is pending recovery");
}
function writePublication(ctx: Context, publication: Publication) {
  const raw = JSON.stringify(publication);
  // Leave room for the final ownership digest before admitting any replacement.
  if (
    publication.files.length > MAX_FILES ||
    Buffer.byteLength(raw) + (publication.nextOwnership === null ? 128 : 0) > MAX_RECORD_BYTES
  )
    throw new Error("Build publication exceeds its recovery limit");
  const temporary = `${pendingPath(ctx)}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const fd = NodeFS.openSync(temporary, "wx", 0o600);
    try {
      NodeFS.writeFileSync(fd, raw);
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.renameSync(temporary, pendingPath(ctx));
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}
function readPublication(ctx: Context) {
  const path = pendingPath(ctx);
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES)
    throw new Error("Unsafe build publication journal");
  const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !("worktreeIdentity" in value) ||
    value.worktreeIdentity !== ctx.worktreeIdentity ||
    !("root" in value) ||
    value.root !== ctx.root ||
    !("phase" in value) ||
    !["preparing", "installing", "committed"].includes(String(value.phase)) ||
    !("now" in value) ||
    typeof value.now !== "number" ||
    !Number.isSafeInteger(value.now) ||
    value.now < 0 ||
    !("previous" in value) ||
    !("nextOwnership" in value) ||
    (value.nextOwnership !== null &&
      (typeof value.nextOwnership !== "string" || !/^[a-f0-9]{64}$/.test(value.nextOwnership))) ||
    !("directories" in value) ||
    !Array.isArray(value.directories) ||
    value.directories.length > MAX_FILES ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_FILES ||
    !("emissions" in value)
  )
    throw new Error("Invalid build publication journal");
  if (value.previous !== null) validateRecord(ctx, value.previous);
  if (value.phase === "committed" && value.nextOwnership === null)
    throw new Error("Committed publication has no ownership record");
  validateRecord(ctx, {
    version: 1,
    worktreeIdentity: ctx.worktreeIdentity,
    root: ctx.root,
    lastUsedAt: value.now,
    files: [],
    emissions: value.emissions,
  });
  const emissionHashes = new Map(
    (value.emissions as BuildRecord["emissions"]).map((file) => [file.path, file.hash]),
  );
  const previousFiles = new Map(
    (value.previous as BuildRecord | null)?.files.map((file) => [
      file.path,
      JSON.stringify(file),
    ]) ?? [],
  );
  const directories = new Set<string>();
  for (const directory of value.directories) {
    if (
      typeof directory !== "object" ||
      directory === null ||
      typeof directory.path !== "string" ||
      !safeRelative(directory.path) ||
      !NodePath.posix.basename(directory.path).startsWith(".t3-build-publication-") ||
      directories.has(directory.path) ||
      typeof directory.allocation !== "string"
    )
      throw new Error("Invalid build preparation directory");
    directories.add(directory.path);
  }
  const files = new Set<string>();
  const temporaries = new Set<string>();
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      !safeRelative(file.path) ||
      files.has(file.path) ||
      typeof file.temporary !== "string" ||
      !safeRelative(file.temporary) ||
      !directories.has(NodePath.posix.dirname(file.temporary)) ||
      !/^[0-9]+\.tmp$/.test(NodePath.posix.basename(file.temporary)) ||
      temporaries.has(file.temporary) ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      typeof file.mode !== "number" ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0xffff ||
      !("prior" in file) ||
      !("prepared" in file) ||
      (file.prepared !== null && typeof file.prepared !== "string") ||
      (value.phase !== "preparing" && typeof file.prepared !== "string")
    )
      throw new Error("Invalid prepared build file");
    if (file.prior !== null)
      validateRecord(ctx, {
        version: 1,
        worktreeIdentity: ctx.worktreeIdentity,
        root: ctx.root,
        lastUsedAt: value.now,
        files: [file.prior],
        emissions: [],
      });
    if (file.prior !== null && file.prior.path !== file.path)
      throw new Error("Invalid prior build destination");
    if (
      NodePath.posix.dirname(NodePath.posix.dirname(file.temporary)) !==
      NodePath.posix.dirname(file.path)
    )
      throw new Error("Prepared output is not beside its destination");
    if (emissionHashes.get(file.path) !== file.hash)
      throw new Error("Prepared output has no compiler emission");
    if (file.prior !== null && JSON.stringify(file.prior) !== previousFiles.get(file.path))
      throw new Error("Prepared output has no prior ownership");
    files.add(file.path);
    temporaries.add(file.temporary);
  }
  if (signature(NodeFS.lstatSync(path)) !== signature(stat))
    throw new Error("Build publication journal changed");
  return value as Publication;
}
function preparationDirectory(ctx: Context, directory: Publication["directories"][number]) {
  const path = safePath(ctx.cwd, `${ctx.root}/${directory.path}`);
  const stat = NodeFS.lstatSync(path);
  if (!stat.isDirectory() || allocation(stat) !== directory.allocation)
    throw new Error("Build preparation directory changed identity");
  return path;
}
function cleanupPreparation(ctx: Context, publication: Publication) {
  const byDirectory = new Map<string, Publication["files"]>();
  for (const file of publication.files) {
    const directory = NodePath.posix.dirname(file.temporary);
    const files = byDirectory.get(directory) ?? [];
    files.push(file);
    byDirectory.set(directory, files);
  }
  for (const directory of publication.directories) {
    let path;
    try {
      path = preparationDirectory(ctx, directory);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    // Only explicitly intended scratch files in this fresh private directory.
    // Arbitrary additions are never traversed or removed.
    for (const file of byDirectory.get(directory.path) ?? []) {
      const temporary = safePath(ctx.cwd, `${ctx.root}/${file.temporary}`);
      try {
        const stat = NodeFS.lstatSync(temporary);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (file.prepared !== null &&
            (allocation(stat) !== file.prepared || fileEvidence(temporary).hash !== file.hash))
        )
          throw new Error("Build preparation changed before cleanup");
        NodeFS.unlinkSync(temporary);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    try {
      NodeFS.rmdirSync(path);
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}
/** Complete only the exact admitted files, under the root mutex. No output glob can mint ownership. */
function recoverPublication(ctx: Context) {
  const publication = readPublication(ctx);
  if (publication.phase === "preparing") {
    cleanupPreparation(ctx, publication);
    NodeFS.unlinkSync(pendingPath(ctx));
    return;
  }
  const current = readRecord(ctx, true);
  const previousSnapshot = recordOwnership(publication.previous);
  const currentSnapshot = ownershipSnapshot(current);
  const currentDigest =
    currentSnapshot === null
      ? null
      : NodeCrypto.createHash("sha256").update(currentSnapshot).digest("hex");
  if (
    currentSnapshot !== previousSnapshot &&
    (publication.nextOwnership === null || currentDigest !== publication.nextOwnership)
  )
    throw new Error("Build ownership changed before recovery");
  if (publication.phase !== "committed") {
    for (const directory of publication.directories) preparationDirectory(ctx, directory);
    const files: OwnedFile[] = [];
    for (const file of publication.files) {
      const destination = safePath(ctx.cwd, `${ctx.root}/${file.path}`);
      const temporary = safePath(ctx.cwd, `${ctx.root}/${file.temporary}`);
      if (NodeFS.existsSync(temporary)) {
        const evidence = fileEvidence(temporary);
        if (
          allocation(NodeFS.lstatSync(temporary)) !== file.prepared ||
          evidence.hash !== file.hash ||
          evidence.mode !== file.mode
        )
          throw new Error("Prepared build output changed before recovery");
        if (file.prior ? !evidenceMatches(file.prior, destination) : NodeFS.existsSync(destination))
          throw new Error("Build destination changed before recovery");
        // Preparation is beside the destination on its actual filesystem.
        // Atomic replacement never exposes partial copied bytes.
        NodeFS.renameSync(temporary, destination);
      }
      const evidence = fileEvidence(destination);
      if (
        allocation(NodeFS.lstatSync(destination)) !== file.prepared ||
        evidence.hash !== file.hash ||
        evidence.mode !== file.mode
      )
        throw new Error("Installed build output changed before recovery");
      files.push({
        path: file.path,
        identity: evidence.identity,
        hash: evidence.hash,
        bytes: evidence.bytes,
      });
    }
    const next: BuildRecord = {
      version: 1,
      worktreeIdentity: ctx.worktreeIdentity,
      root: ctx.root,
      lastUsedAt: Math.max(publication.now, current?.record.lastUsedAt ?? 0),
      files,
      emissions: publication.emissions,
    };
    publication.nextOwnership = NodeCrypto.createHash("sha256")
      .update(recordOwnership(next)!)
      .digest("hex");
    writePublication(ctx, publication);
    const latest = readRecord(ctx, true);
    if (ownershipSnapshot(latest) !== ownershipSnapshot(current))
      throw new Error("Build ownership changed during recovery");
    if (!writeRecord(ctx, next, latest?.recordIdentity))
      throw new Error("Build ownership changed during recovery");
    publication.phase = "committed";
    writePublication(ctx, publication);
  }
  const emitted = new Set(publication.emissions.map((file) => file.path));
  for (const file of publication.previous?.files ?? []) {
    if (emitted.has(file.path)) continue;
    let destination;
    try {
      destination = safePath(ctx.cwd, `${ctx.root}/${file.path}`);
      if (!evidenceMatches(file, destination)) continue;
    } catch {
      continue;
    } // Edited, missing or unverifiable history remains unowned.
    NodeFS.unlinkSync(destination);
    let parent = NodePath.dirname(destination);
    const output = NodePath.join(ctx.cwd, ctx.root);
    while (parent.startsWith(`${output}${NodePath.sep}`) || parent === output) {
      try {
        NodeFS.rmdirSync(parent);
      } catch {
        break;
      }
      parent = NodePath.dirname(parent);
    }
  }
  cleanupPreparation(ctx, publication);
  NodeFS.unlinkSync(pendingPath(ctx));
}

/** Metadata-only clock observation; does not hash, adopt or renew any output. */
export function generatedBuildActivity(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  const previous = ctx && readRecord(ctx);
  return previous ? { token: previous.token, lastUsedAt: previous.record.lastUsedAt } : null;
}

/** Provenance is evidence of emitted bytes, never deletion consent. Caller owns policy, Git, leases and read protection. */
export function inspectGeneratedBuildOwnership(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous) return null;
  const files = previous.record.files.map((file) => {
    let reason: string | null = null;
    try {
      if (!evidenceMatches(file, safePath(ctx.cwd, `${root}/${file.path}`)))
        reason = "Generated file changed since emission";
    } catch (error) {
      reason = missing(error)
        ? "Generated file is absent"
        : "Generated file cannot be safely verified";
    }
    return { ...file, reason };
  });
  return { token: previous.token, lastUsedAt: previous.record.lastUsedAt, files };
}

async function asynchronousFileEvidence(target: string, signal?: AbortSignal) {
  const before = await NodeFS.promises.lstat(target);
  if (!before.isFile() || before.nlink !== 1)
    throw new Error("Generated output is not an exclusive regular file");
  const hash = NodeCrypto.createHash("sha256");
  const file = await NodeFS.promises.open(
    target,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (signature(await file.stat()) !== signature(before))
      throw new Error("Generated output identity changed before hashing");
    for await (const chunk of file.createReadStream({
      autoClose: false,
      ...(signal ? { signal } : {}),
    }))
      hash.update(chunk as Uint8Array);
  } finally {
    await file.close();
  }
  if (signature(await NodeFS.promises.lstat(target)) !== signature(before))
    throw new Error("Generated output changed during observation");
  return { identity: signature(before), hash: hash.digest("hex") };
}

/** Server sweeps stream file contents without blocking the request loop on a whole build tree. */
export async function inspectGeneratedBuildOwnershipAsync(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous) return null;
  const files: Array<OwnedFile & { reason: string | null }> = [];
  for (const file of previous.record.files) {
    let reason: string | null = null;
    try {
      const current = await asynchronousFileEvidence(safePath(ctx.cwd, `${root}/${file.path}`));
      if (current.identity !== file.identity || current.hash !== file.hash)
        reason = "Generated file changed since emission";
    } catch (error) {
      reason = missing(error)
        ? "Generated file is absent"
        : "Generated file cannot be safely verified";
    }
    files.push({ ...file, reason });
  }
  return { token: previous.token, lastUsedAt: previous.record.lastUsedAt, files };
}

type RemovalResult = {
  bytes: number;
  files: number;
  kept: Array<{ path: string; reason: string }>;
};
type RemovalAuthority = {
  files: OwnedFile[];
  changedReason: string;
  validate: () => string | null;
  consume: (files: readonly OwnedFile[]) => void;
};

function compilerRemovalAuthority(ctx: Context, expectedToken: string): RemovalAuthority {
  const previous = readRecord(ctx);
  if (!previous || previous.token !== expectedToken)
    throw new Error("Build ownership changed before removal");
  return {
    files: previous.record.files,
    changedReason: "Generated file changed since emission",
    validate: () => {
      if (generatedBuildReviewProtection(ctx.cwd, ctx.root))
        return "Reviewed build content remains protected";
      return signature(NodeFS.lstatSync(ctx.recordPath)) === previous.recordIdentity
        ? null
        : "Build ownership changed before removal";
    },
    consume: () => {},
  };
}

function requestedRemovalFiles(authority: RemovalAuthority, paths: readonly string[]) {
  const owned = new Map(authority.files.map((file) => [file.path, file]));
  return [...new Set(paths)].map((path) => {
    const file = owned.get(path);
    if (!file) throw new Error("Requested file has no deletion authority");
    return file;
  });
}

function removalProgress(requested: OwnedFile[]) {
  const result: RemovalResult = { bytes: 0, files: 0, kept: [] };
  const removed = new Set<string>();
  const stop = (offset: number, reason: string) => {
    const alreadyKept = new Set(result.kept.map(({ path }) => path));
    result.kept.push(
      ...requested
        .slice(offset)
        .filter(({ path }) => !alreadyKept.has(path) && !removed.has(path))
        .map(({ path }) => ({ path, reason })),
    );
    return result;
  };
  return { result, removed, stop };
}

/** Both authority adapters enter the same mutex, final identity check and exact unlink seam. */
function removeVerifiedBatch(
  ctx: Context,
  batch: OwnedFile[],
  verified: Set<string>,
  authority: RemovalAuthority,
  progress: ReturnType<typeof removalProgress>,
  signal?: AbortSignal,
  strictErrors = false,
) {
  let release;
  try {
    release = tryAcquireBuildMutationLock(ctx);
  } catch (error) {
    if (strictErrors) throw error;
    return "Build output lock could not be acquired safely";
  }
  if (!release) return "Build output is busy; retry cleanup";
  try {
    if (hasPendingPublication(ctx)) return "Build publication is pending recovery";
    const refusal = authority.validate();
    if (refusal) return refusal;
    const ready: OwnedFile[] = [];
    for (const file of batch) {
      if (!verified.has(file.path)) continue;
      try {
        const stat = NodeFS.lstatSync(safePath(ctx.cwd, `${ctx.root}/${file.path}`));
        if (!stat.isFile() || stat.nlink !== 1 || signature(stat) !== file.identity)
          progress.result.kept.push({
            path: file.path,
            reason: "Generated file changed before removal",
          });
        else ready.push(file);
      } catch (error) {
        progress.result.kept.push({
          path: file.path,
          reason: missing(error)
            ? "Generated file is absent"
            : "Generated file cannot be safely verified",
        });
      }
    }
    if (ready.length === 0) return null;
    // One atomic bounded receipt write per batch consumes consent before unlink,
    // so a crash or failed unlink cannot make a removed identity reusable.
    try {
      authority.consume(ready);
    } catch {
      return "Build deletion consent could not be consumed safely";
    }
    for (const file of ready) {
      if (signal?.aborted) return "Build cleanup was cancelled";
      try {
        const refusal = authority.validate();
        if (refusal) return refusal;
        const target = safePath(ctx.cwd, `${ctx.root}/${file.path}`);
        const stat = NodeFS.lstatSync(target);
        // Hashing and awaited process/policy checks finish before the lock. Ctime
        // prevents accepting rewritten bytes with restored mtime and size.
        if (!stat.isFile() || stat.nlink !== 1 || signature(stat) !== file.identity) {
          progress.result.kept.push({
            path: file.path,
            reason: "Generated file changed before removal",
          });
          continue;
        }
        NodeFS.unlinkSync(target);
        progress.result.bytes += file.bytes;
        progress.result.files++;
        progress.removed.add(file.path);
        let parent = NodePath.dirname(target);
        const output = NodePath.join(ctx.cwd, ctx.root);
        while (parent.startsWith(`${output}${NodePath.sep}`) || parent === output) {
          try {
            NodeFS.rmdirSync(parent);
          } catch {
            break;
          }
          parent = NodePath.dirname(parent);
        }
      } catch (error) {
        if (strictErrors && !missing(error)) throw error;
        progress.result.kept.push({
          path: file.path,
          reason: missing(error)
            ? "Generated file is absent"
            : "Generated file could not be removed safely",
        });
      }
    }
    return null;
  } catch (error) {
    if (strictErrors) throw error;
    return "Build deletion authority could not be checked safely";
  } finally {
    release();
  }
}

async function removeAuthorizedFilesAsync(
  ctx: Context,
  authority: RemovalAuthority,
  paths: readonly string[],
  revalidate: (paths: readonly string[]) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const requested = requestedRemovalFiles(authority, paths);
  const progress = removalProgress(requested);
  for (let offset = 0; offset < requested.length; offset += 64) {
    if (signal?.aborted) return progress.stop(offset, "Build cleanup was cancelled");
    const batch = requested.slice(offset, offset + 64);
    const verified = new Set<string>();
    for (const file of batch) {
      if (signal?.aborted) return progress.stop(offset, "Build cleanup was cancelled");
      try {
        const current = await asynchronousFileEvidence(
          safePath(ctx.cwd, `${ctx.root}/${file.path}`),
          signal,
        );
        if (current.identity === file.identity && current.hash === file.hash)
          verified.add(file.path);
        else progress.result.kept.push({ path: file.path, reason: authority.changedReason });
      } catch (error) {
        progress.result.kept.push({
          path: file.path,
          reason: missing(error)
            ? "Generated file is absent"
            : "Generated file cannot be safely verified",
        });
      }
    }
    if (verified.size === 0) continue;
    if (signal?.aborted) return progress.stop(offset, "Build cleanup was cancelled");
    try {
      if (!(await revalidate([...verified])))
        return progress.stop(offset, "Build cleanup guards changed before removal");
    } catch {
      return progress.stop(offset, "Build cleanup guards could not be checked");
    }
    if (signal?.aborted) return progress.stop(offset, "Build cleanup was cancelled");
    const refusal = removeVerifiedBatch(ctx, batch, verified, authority, progress, signal);
    if (refusal) return progress.stop(offset, refusal);
  }
  return progress.result;
}

/** Hash bounded batches, then refresh policy/consumers before synchronous final identity checks. */
export async function removeGeneratedBuildFilesAsync(
  worktreePath: string,
  root: string,
  expectedToken: string,
  paths: readonly string[],
  revalidate: (paths: readonly string[]) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build ownership requires a linked worktree");
  return removeAuthorizedFilesAsync(
    ctx,
    compilerRemovalAuthority(ctx, expectedToken),
    paths,
    revalidate,
    signal,
  );
}

/** Only positive evidence of an actual compiled-output consumer may renew this clock. */
export function recordGeneratedBuildUse(worktreePath: string, root: string, now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid build use time");
  const ctx = context(worktreePath, root);
  if (!ctx) return false;
  const release = tryAcquireBuildMutationLock(ctx);
  if (!release) return false;
  try {
    if (hasPendingPublication(ctx)) return false;
    const previous = readRecord(ctx);
    if (!previous) return false;
    return writeRecord(
      ctx,
      { ...previous.record, lastUsedAt: Math.max(now, previous.record.lastUsedAt) },
      previous.recordIdentity,
    );
  } finally {
    release();
  }
}

/** Exact selective deletion only; retained review markers also protect compiler-owned output. */
export function removeGeneratedBuildFiles(
  worktreePath: string,
  root: string,
  expectedToken: string,
  paths: readonly string[],
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build ownership requires a linked worktree");
  const authority = compilerRemovalAuthority(ctx, expectedToken);
  const requested = requestedRemovalFiles(authority, paths);
  const progress = removalProgress(requested);
  for (const [index, file] of requested.entries()) {
    try {
      if (!evidenceMatches(file, safePath(ctx.cwd, `${root}/${file.path}`))) {
        progress.result.kept.push({ path: file.path, reason: authority.changedReason });
        continue;
      }
      const refusal = removeVerifiedBatch(
        ctx,
        [file],
        new Set([file.path]),
        authority,
        progress,
        undefined,
        true,
      );
      if (refusal) return progress.stop(index, refusal);
    } catch (error) {
      if (!missing(error)) throw error;
      progress.result.kept.push({ path: file.path, reason: "Generated file is absent" });
    }
  }
  return progress.result;
}

/** The runner creates an empty private stage before invoking a compiler. Only that stage can mint provenance. */
export function createGeneratedBuildStage(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  if (!ctx) return null; // Ordinary repository builds keep their existing output behavior.
  if (hasPendingPublication(ctx)) {
    const release = acquireBuildMutationLock(ctx);
    try {
      recoverPublication(ctx);
    } finally {
      release();
    }
  }
  let initial = readRecord(ctx);
  const directory = NodeFS.mkdtempSync(NodePath.join(ctx.gitDir, "t3-build-stage-"));
  const initialAllocation = allocation(NodeFS.lstatSync(directory));
  let finished = false;
  let pendingPublicationId: string | null = null;
  const discard = () => {
    if (finished) return;
    if (
      NodeFS.realpathSync(directory) !== directory ||
      allocation(NodeFS.lstatSync(directory)) !== initialAllocation
    )
      throw new Error("Build stage changed identity");
    NodeFS.rmSync(directory, { recursive: true, maxRetries: 3 }); // Only the fresh, runner-owned stage, never an actual output root.
    finished = true;
  };
  return {
    directory,
    discard,
    publish(now: number, sourceDirectory = directory, retainStage = false) {
      if (finished || !Number.isSafeInteger(now) || now < 0)
        throw new Error("Invalid build publication");
      const source = NodeFS.realpathSync(sourceDirectory);
      if (source !== directory && !source.startsWith(`${directory}${NodePath.sep}`))
        throw new Error("Output is outside the runner-owned stage");
      if (allocation(NodeFS.lstatSync(directory)) !== initialAllocation)
        throw new Error("Build stage changed identity");
      // Cleanup can observe an actual compiler consumer while this runner is
      // staging. Timestamp-only renewal does not supersede emitted ownership.
      const emitted: Array<OwnedFile & { source: string; mode: number }> = [];
      const stageLinks = new Map<string, { count: number; links: number }>();
      const visit = (dir: string, prefix: string) => {
        for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
          const relative = `${prefix}${entry.name}`;
          const target = safePath(source, relative);
          if (entry.isDirectory()) visit(target, `${relative}/`);
          else {
            if (emitted.length >= MAX_FILES) throw new Error("Build emitted too many files");
            const stat = NodeFS.lstatSync(target);
            const key = `${stat.dev}:${stat.ino}`;
            const priorLink = stageLinks.get(key);
            stageLinks.set(key, { count: (priorLink?.count ?? 0) + 1, links: stat.nlink });
            emitted.push({ path: relative, source: target, ...fileEvidence(target, true) });
          }
        }
      };
      visit(source, "");
      // Cargo hardlinks executables within its own target tree. Every link must
      // be accounted for inside the fresh stage; a link outside it is not owned.
      if ([...stageLinks.values()].some((entry) => entry.count !== entry.links))
        throw new Error("Build stage contains an external hardlink");
      // Compilation and stage hashing stay parallel. Serialize admission through
      // retirement across processes, including identical-but-unowned emissions.
      // Contention preserves the stage for retry; every transaction exits the lock.
      const release = acquireBuildMutationLock(ctx);
      try {
        // A watch runner can recover its own interrupted publication without
        // treating a competing publication as permission to refresh its baseline.
        if (
          pendingPublicationId !== null &&
          hasPendingPublication(ctx) &&
          readPublication(ctx).id === pendingPublicationId
        ) {
          recoverPublication(ctx);
          initial = readRecord(ctx);
          pendingPublicationId = null;
        }
        const initialOwnership = ownershipSnapshot(initial);
        if (ownershipSnapshot(readRecord(ctx)) !== initialOwnership)
          throw new Error("Another build changed output ownership");
        const priorFiles = new Map(initial?.record.files.map((file) => [file.path, file]) ?? []);
        const plans = emitted.map((file) => {
          const destination = safePath(ctx.cwd, `${root}/${file.path}`);
          try {
            const existing = fileEvidence(destination);
            const prior = priorFiles.get(file.path);
            if (prior && existing.identity === prior.identity && existing.hash === prior.hash)
              return { file, destination, prior, skip: false };
            if (existing.hash === file.hash)
              return { file, destination, prior: undefined, skip: true };
            throw new Error(`Build output collision requires file review: ${root}/${file.path}`);
          } catch (error) {
            if (missing(error)) return { file, destination, prior: undefined, skip: false };
            throw error;
          }
        });
        const latest = readRecord(ctx);
        if (ownershipSnapshot(latest) !== initialOwnership)
          throw new Error("Another build changed output ownership");
        const transaction: Publication = {
          version: 1,
          id: NodeCrypto.randomUUID(),
          worktreeIdentity: ctx.worktreeIdentity,
          root,
          phase: "preparing",
          previous: latest?.record ?? null,
          nextOwnership: null,
          now: Math.max(now, latest?.record.lastUsedAt ?? 0),
          emissions: emitted.map(({ path, hash }) => ({ path, hash })),
          directories: [],
          files: [],
        };
        try {
          const directories = new Map<string, string>();
          for (const [index, { file, destination, prior, skip }] of plans.entries()) {
            if (skip) continue; // Identical unknown bytes remain unowned.
            safePath(ctx.cwd, `${root}/${file.path}`);
            NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
            const parent = NodePath.dirname(destination);
            let directory = directories.get(parent);
            if (!directory) {
              directory = NodeFS.mkdtempSync(NodePath.join(parent, ".t3-build-publication-"));
              directories.set(parent, directory);
              transaction.directories.push({
                path: NodePath.relative(NodePath.join(ctx.cwd, root), directory)
                  .split(NodePath.sep)
                  .join("/"),
                allocation: allocation(NodeFS.lstatSync(directory)),
              });
            }
            transaction.files.push({
              path: file.path,
              temporary: NodePath.relative(
                NodePath.join(ctx.cwd, root),
                NodePath.join(directory, `${index}.tmp`),
              )
                .split(NodePath.sep)
                .join("/"),
              prior: prior ?? null,
              hash: file.hash,
              mode: file.mode,
              prepared: null,
            });
          }
          // Preparation has its own lifetime; compiler-stage discard cannot erase it.
          writePublication(ctx, transaction);
          const emittedByPath = new Map(emitted.map((file) => [file.path, file]));
          for (const plan of transaction.files) {
            const file = emittedByPath.get(plan.path)!;
            const temporary = safePath(ctx.cwd, `${root}/${plan.temporary}`);
            NodeFS.copyFileSync(file.source, temporary, NodeFS.constants.COPYFILE_EXCL);
            NodeFS.chmodSync(temporary, plan.mode);
            flushPreparedFile(temporary);
            const evidence = fileEvidence(temporary);
            if (evidence.hash !== plan.hash) throw new Error("Prepared compiler output changed");
            plan.prepared = allocation(NodeFS.lstatSync(temporary));
          }
          transaction.phase = "installing";
          writePublication(ctx, transaction);
          pendingPublicationId = transaction.id;
        } catch (error) {
          // No published byte changes before a complete verified intent is persisted.
          cleanupPreparation(ctx, transaction);
          if (hasPendingPublication(ctx)) NodeFS.unlinkSync(pendingPath(ctx));
          throw error;
        }
        recoverPublication(ctx);
        initial = readRecord(ctx);
        pendingPublicationId = null;
      } finally {
        release();
      }
      if (!retainStage) discard();
    },
  };
}

/** Copy only the latest verified compiler emissions, never arbitrary additions in the real dist tree. */
export function copyOwnedGeneratedBuild(worktreePath: string, root: string, destination: string) {
  const ctx = context(worktreePath, root);
  if (!ctx) {
    try {
      if (NodeFS.lstatSync(NodePath.join(NodeFS.realpathSync(worktreePath), ".git")).isDirectory())
        return false; // Only positively recognized ordinary repositories use the caller's copy.
    } catch (error) {
      if (!missing(error)) throw error;
    }
    throw new Error("Generated build copy requires repository metadata");
  }
  const previous = readRecord(ctx);
  if (!previous) throw new Error("Generated build has no emission provenance; rebuild first");
  // Only the latest compiler emission belongs in a newly built server client bundle.
  for (const file of previous.record.emissions) {
    const source = safePath(ctx.cwd, `${root}/${file.path}`);
    if (fileEvidence(source).hash !== file.hash)
      throw new Error("Web output changed since compiler emission");
    const target = safePath(destination, file.path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(source, target, NodeFS.constants.COPYFILE_EXCL);
    if (fileEvidence(target).hash !== file.hash)
      throw new Error("Web output changed during server build");
  }
  return true;
}

type ReviewRecord = {
  version: 1;
  worktreeIdentity: string;
  root: string;
  rootAllocation: string;
  lastUsedAt: number;
  useToken: string;
  protected: boolean;
  contextKey: string | null;
  files: OwnedFile[];
};
type ReviewSnapshot = { record: ReviewRecord; token: string };
type ReviewFile = {
  path: string;
  identity: string;
  hash: string | null;
  size: number;
  bytes: number;
  selectable: boolean;
  reason: string | null;
};
const MAX_REVIEW_FILES = 1_000;
const MAX_REVIEW_CONTENT_BYTES = 512 * 1024 * 1024;
const reviewPath = (ctx: Context) =>
  NodePath.join(
    ctx.gitDir,
    `t3-build-review-${NodeCrypto.createHash("sha256").update(ctx.root).digest("hex")}.json`,
  );
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const validTime = (now: number) => Number.isSafeInteger(now) && now >= 0;

function rootAllocation(ctx: Context) {
  const stat = NodeFS.lstatSync(safePath(ctx.cwd, ctx.root));
  if (!stat.isDirectory()) throw new Error("Build review requires an existing directory");
  return allocation(stat);
}

function readReview(ctx: Context): ReviewSnapshot | null {
  const path = reviewPath(ctx);
  let fd;
  try {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES)
      throw new Error("Unsafe build review record");
    const raw = NodeFS.readFileSync(fd, "utf8");
    const value = JSON.parse(raw) as Partial<ReviewRecord> | null;
    if (
      typeof value !== "object" ||
      value === null ||
      value.version !== 1 ||
      value.worktreeIdentity !== ctx.worktreeIdentity ||
      value.root !== ctx.root ||
      typeof value.rootAllocation !== "string" ||
      typeof value.lastUsedAt !== "number" ||
      !validTime(value.lastUsedAt) ||
      typeof value.useToken !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.useToken) ||
      typeof value.protected !== "boolean" ||
      (value.contextKey !== null && typeof value.contextKey !== "string") ||
      !Array.isArray(value.files) ||
      value.files.length > MAX_REVIEW_FILES ||
      (!value.protected && (value.files.length !== 0 || value.contextKey !== null))
    )
      throw new Error("Invalid build review record");
    const paths = new Set<string>();
    for (const file of value.files) {
      if (
        typeof file !== "object" ||
        file === null ||
        typeof file.path !== "string" ||
        !safeRelative(file.path) ||
        paths.has(file.path) ||
        typeof file.identity !== "string" ||
        typeof file.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.hash) ||
        typeof file.bytes !== "number" ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0
      )
        throw new Error("Invalid reviewed build file");
      paths.add(file.path);
    }
    if (
      signature(NodeFS.lstatSync(path)) !== signature(stat) ||
      signature(NodeFS.fstatSync(fd)) !== signature(stat)
    )
      throw new Error("Build review changed during observation");
    return {
      record: value as ReviewRecord,
      token: digest(raw + signature(stat)),
    };
  } finally {
    NodeFS.closeSync(fd);
  }
}

function writeReview(ctx: Context, record: ReviewRecord) {
  const raw = JSON.stringify(record);
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES)
    throw new Error("Build review exceeds its observation limit");
  const path = reviewPath(ctx);
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
    flushPreparedFile(temporary);
    NodeFS.renameSync(temporary, path);
    return readReview(ctx)!;
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

function assertLegacyBuild(ctx: Context) {
  const current = context(ctx.cwd, ctx.root);
  if (
    !current ||
    current.worktreeIdentity !== ctx.worktreeIdentity ||
    current.gitDir !== ctx.gitDir
  )
    throw new Error("Build worktree changed; refresh review");
  if (readRecord(ctx)) throw new Error("Build now has compiler provenance; refresh review");
}
const reviewActivity = (snapshot: ReviewSnapshot) => ({
  token: snapshot.token,
  lastUsedAt: snapshot.record.lastUsedAt,
  hasSelection: snapshot.record.files.length > 0,
});

/** First observation measures a full future delay; filesystem timestamps never establish age. */
export function observeLegacyBuild(
  worktreePath: string,
  root: string,
  now: number,
  persist = true,
) {
  if (!validTime(now)) throw new Error("Invalid build observation time");
  const ctx = context(worktreePath, root);
  if (!ctx) return null;
  const release = persist ? acquireBuildMutationLock(ctx) : () => {};
  try {
    if (readRecord(ctx)) return null;
    const currentAllocation = rootAllocation(ctx);
    const previous = readReview(ctx);
    if (previous?.record.rootAllocation === currentAllocation) return reviewActivity(previous);
    const next: ReviewRecord = {
      version: 1,
      worktreeIdentity: ctx.worktreeIdentity,
      root,
      rootAllocation: currentAllocation,
      lastUsedAt: Math.max(now, previous?.record.lastUsedAt ?? 0),
      useToken: NodeCrypto.randomUUID(),
      protected: previous?.record.protected ?? false,
      contextKey: null,
      files: [],
    };
    return persist
      ? reviewActivity(writeReview(ctx, next))
      : {
          token: digest(JSON.stringify(next)),
          lastUsedAt: next.lastUsedAt,
          hasSelection: false,
        };
  } finally {
    release();
  }
}

/** Metadata-only legacy clock observation. It neither hashes files nor refreshes consent or age. */
export function legacyBuildActivity(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  if (!ctx || readRecord(ctx)) return null;
  const previous = readReview(ctx);
  if (!previous || rootAllocation(ctx) !== previous.record.rootAllocation) return null;
  return reviewActivity(previous);
}

/** Positive evidence of an actual output consumer renews age and revokes every selected identity. */
export function recordLegacyBuildUse(worktreePath: string, root: string, now: number) {
  if (!validTime(now)) throw new Error("Invalid build use time");
  const ctx = context(worktreePath, root);
  if (!ctx) return false;
  const release = tryAcquireBuildMutationLock(ctx);
  if (!release) return false;
  try {
    if (readRecord(ctx)) return false;
    const previous = readReview(ctx);
    writeReview(ctx, {
      version: 1,
      worktreeIdentity: ctx.worktreeIdentity,
      root,
      rootAllocation: rootAllocation(ctx),
      lastUsedAt: Math.max(now, previous?.record.lastUsedAt ?? 0),
      useToken: NodeCrypto.randomUUID(),
      protected: previous?.record.protected ?? false,
      contextKey: null,
      files: [],
    });
    return true;
  } finally {
    release();
  }
}

/** Retained review protection is independent of owners, compiler records, and surviving output files. */
export function generatedBuildReviewProtection(worktreePath: string, relativeCandidate = "") {
  if (relativeCandidate !== "" && !safeRelative(relativeCandidate)) return true;
  try {
    const ctx = context(worktreePath, "apps/web/dist");
    if (!ctx) return false;
    for (const name of NodeFS.readdirSync(ctx.gitDir)) {
      if (!name.startsWith("t3-build-review-") || !name.endsWith(".json")) continue;
      const match = /^t3-build-review-([a-f0-9]{64})\.json$/.exec(name);
      if (!match) return true;
      const path = NodePath.join(ctx.gitDir, name);
      const stat = NodeFS.lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) return true;
      // Find the recognized root without trusting the unvalidated record to redirect reads.
      const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as { root?: unknown };
      if (
        typeof value?.root !== "string" ||
        !allowedRoot(value.root) ||
        digest(value.root) !== match[1]
      )
        return true;
      const previous = readReview({ ...ctx, root: value.root });
      if (!previous) return true;
      if (!previous.record.protected) continue;
      const root = previous.record.root;
      if (
        relativeCandidate === "" ||
        relativeCandidate === root ||
        root.startsWith(`${relativeCandidate}/`) ||
        relativeCandidate.startsWith(`${root}/`)
      )
        return true;
    }
    return false;
  } catch {
    return true;
  }
}

type Inventory = {
  files: ReviewFile[];
  directories: Array<{ path: string; identity: string }>;
  rootAllocation: string;
};
async function reviewInventory(ctx: Context): Promise<Inventory> {
  const initialAllocation = rootAllocation(ctx);
  const files: ReviewFile[] = [];
  const directories: Inventory["directories"] = [];
  let size = 0;
  let entries = 0;
  const visit = async (relative: string, depth: number) => {
    if (depth > 64 || ++entries > 5_000) throw new Error("Build review inventory is too large");
    const directory = safePath(ctx.cwd, relative ? `${ctx.root}/${relative}` : ctx.root);
    const before = await NodeFS.promises.lstat(directory);
    if (!before.isDirectory()) throw new Error("Build review directory changed");
    directories.push({ path: relative, identity: signature(before) });
    const children = (await NodeFS.promises.readdir(directory)).sort();
    for (const name of children) {
      if (++entries > 5_000) throw new Error("Build review inventory is too large");
      const path = relative ? `${relative}/${name}` : name;
      const target = NodePath.join(directory, name);
      const stat = await NodeFS.promises.lstat(target);
      if (safeRelative(path) && stat.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (files.length >= MAX_REVIEW_FILES) throw new Error("Build review exceeds 1000 files");
      const regular = stat.isFile();
      const bytes = Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
      if (regular) {
        size += stat.size;
        if (size > MAX_REVIEW_CONTENT_BYTES) throw new Error("Build review exceeds 512 MiB");
      }
      const reason = !safeRelative(path)
        ? "Unsafe file path"
        : stat.isSymbolicLink()
          ? "Symbolic links cannot be selected"
          : !regular
            ? "Only regular files can be selected"
            : stat.nlink !== 1
              ? "Hardlinked files cannot be selected"
              : null;
      let hash: string | null = null;
      if (reason === null) {
        const evidence = await asynchronousFileEvidence(safePath(ctx.cwd, `${ctx.root}/${path}`));
        if (evidence.identity !== signature(stat)) throw new Error("Build review file changed");
        hash = evidence.hash;
      }
      files.push({
        path,
        identity: signature(stat),
        hash,
        size: regular ? stat.size : 0,
        bytes,
        selectable: reason === null,
        reason,
      });
    }
    if (signature(await NodeFS.promises.lstat(directory)) !== signature(before))
      throw new Error("Build review directory changed during observation");
  };
  await visit("", 0);
  if (rootAllocation(ctx) !== initialAllocation)
    throw new Error("Build root changed during review");
  return { files, directories, rootAllocation: initialAllocation };
}

function assertInventoryCurrent(ctx: Context, inventory: Inventory) {
  if (rootAllocation(ctx) !== inventory.rootAllocation)
    throw new Error("Build root changed during review");
  for (const directory of inventory.directories) {
    const path = safePath(ctx.cwd, directory.path ? `${ctx.root}/${directory.path}` : ctx.root);
    const stat = NodeFS.lstatSync(path);
    if (!stat.isDirectory() || signature(stat) !== directory.identity)
      throw new Error("Build review inventory changed; refresh review");
  }
  for (const file of inventory.files) {
    // Directory traversal was already checked. Lstat the final entry without
    // following links, including unsafe names that remain display-only.
    const parent = NodePath.posix.dirname(file.path);
    const directory = safePath(ctx.cwd, parent === "." ? ctx.root : `${ctx.root}/${parent}`);
    const stat = NodeFS.lstatSync(NodePath.join(directory, NodePath.posix.basename(file.path)));
    if (
      signature(stat) !== file.identity ||
      (file.selectable && (!stat.isFile() || stat.nlink !== 1))
    )
      throw new Error("Build review file changed; refresh review");
  }
}
function previewFingerprint(
  ctx: Context,
  contextKey: string,
  state: ReviewSnapshot,
  inventory: Inventory,
) {
  return digest(
    JSON.stringify({
      worktree: ctx.worktreeIdentity,
      contextKey,
      useToken: state.record.useToken,
      lastUsedAt: state.record.lastUsedAt,
      inventory,
      recordToken: state.token,
    }),
  );
}

/** A bounded complete preview; hashes stream outside the root publication mutex. */
async function prepareLegacyPreview(
  worktreePath: string,
  root: string,
  now: number,
  contextKey: string,
) {
  if (contextKey.length === 0) throw new Error("Build review context is required");
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build review requires a linked worktree");
  if (!observeLegacyBuild(worktreePath, root, now))
    throw new Error("Build now has compiler provenance; refresh review");
  const stateRelease = acquireBuildMutationLock(ctx);
  let state: ReviewSnapshot;
  try {
    validReviewedState(ctx, contextKey, true);
    state = readReview(ctx)!;
  } finally {
    stateRelease();
  }
  const inventory = await reviewInventory(ctx);
  const release = acquireBuildMutationLock(ctx);
  try {
    assertLegacyBuild(ctx);
    if (readReview(ctx)?.token !== state.token)
      throw new Error("Build activity changed; refresh review");
    assertInventoryCurrent(ctx, inventory);
    const preview = {
      token: previewFingerprint(ctx, contextKey, state, inventory),
      lastUsedAt: state.record.lastUsedAt,
      files: inventory.files,
      selectedPaths:
        state.record.contextKey === contextKey &&
        state.record.rootAllocation === inventory.rootAllocation
          ? state.record.files
              .filter((file) =>
                inventory.files.some(
                  (current) =>
                    current.selectable &&
                    current.path === file.path &&
                    current.identity === file.identity &&
                    current.hash === file.hash,
                ),
              )
              .map((file) => file.path)
          : [],
      bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0),
      size: inventory.files.reduce((sum, file) => sum + file.size, 0),
    };
    return { preview, state, inventory };
  } finally {
    release();
  }
}

/** A complete identity-bound preview. Selection never grants authority until explicitly saved. */
export async function previewLegacyBuild(
  worktreePath: string,
  root: string,
  now: number,
  contextKey: string,
) {
  return (await prepareLegacyPreview(worktreePath, root, now, contextKey)).preview;
}

/** Approval is separate from compiler provenance and actual-use time, including an empty tombstone. */
export async function saveLegacyBuildSelection(
  worktreePath: string,
  root: string,
  now: number,
  contextKey: string,
  previewToken: string,
  selectedPaths: readonly string[],
  revalidate?: (paths: readonly string[]) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build review requires a linked worktree");
  const { preview, state, inventory } = await prepareLegacyPreview(
    worktreePath,
    root,
    now,
    contextKey,
  );
  if (preview.token !== previewToken) throw new Error("Build preview changed; refresh review");
  const requested = [...new Set(selectedPaths)];
  const files = requested.map((path) => {
    const file = preview.files.find((candidate) => candidate.path === path);
    if (!file?.selectable || file.hash === null)
      throw new Error("File cannot be selected for build cleanup");
    return { path, identity: file.identity, hash: file.hash, bytes: file.bytes };
  });
  if (signal?.aborted) throw new Error("Build review was cancelled");
  if (revalidate && !(await revalidate(requested)))
    throw new Error("Build review guards changed; refresh review");
  if (signal?.aborted) throw new Error("Build review was cancelled");
  const release = acquireBuildMutationLock(ctx);
  try {
    assertLegacyBuild(ctx);
    if (readReview(ctx)?.token !== state.token || state.record.lastUsedAt !== preview.lastUsedAt)
      throw new Error("Build activity changed; refresh review");
    assertInventoryCurrent(ctx, inventory);
    if (rootAllocation(ctx) !== state.record.rootAllocation)
      throw new Error("Build root changed; refresh review");
    for (const file of files) {
      const stat = NodeFS.lstatSync(safePath(ctx.cwd, `${root}/${file.path}`));
      if (!stat.isFile() || stat.nlink !== 1 || signature(stat) !== file.identity)
        throw new Error("Selected file changed; refresh review");
    }
    return reviewActivity(
      writeReview(ctx, { ...state.record, protected: true, contextKey, files }),
    );
  } finally {
    release();
  }
}

function validReviewedState(ctx: Context, contextKey: string, revokeInvalid = false) {
  const previous = readReview(ctx);
  if (!previous?.record.protected) return null;
  let valid = false;
  try {
    assertLegacyBuild(ctx);
    valid =
      previous.record.contextKey === contextKey &&
      previous.record.rootAllocation === rootAllocation(ctx);
  } catch {
    valid = false;
  }
  if (valid) return previous;
  // Callers requesting revocation already own the root mutex. A context or
  // allocation returning to an old value must never resurrect old approval.
  if (revokeInvalid && previous.record.files.length > 0)
    writeReview(ctx, { ...previous.record, contextKey: null, files: [] });
  return null;
}

function openReviewedState(ctx: Context, contextKey: string) {
  const current = validReviewedState(ctx, contextKey);
  if (current) return current;
  const release = tryAcquireBuildMutationLock(ctx);
  if (!release) return null;
  try {
    return validReviewedState(ctx, contextKey, true);
  } finally {
    release();
  }
}

/** Observe policy/mapping changes before inactivity or Off can skip content inspection. */
export function validateLegacyBuildReviewContext(
  worktreePath: string,
  root: string,
  contextKey: string,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) return false;
  const release = acquireBuildMutationLock(ctx);
  try {
    const current = validReviewedState(ctx, contextKey, true);
    return current !== null && current.record.files.length > 0;
  } finally {
    release();
  }
}

/** Inspect only exact currently approved identities; stale or consumed consent grants no authority. */
export async function inspectReviewedBuildFilesAsync(
  worktreePath: string,
  root: string,
  contextKey: string,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) return null;
  let previous;
  try {
    previous = openReviewedState(ctx, contextKey);
  } catch {
    return null;
  }
  if (!previous || previous.record.files.length === 0) return null;
  const files: Array<OwnedFile & { reason: string | null }> = [];
  for (const file of previous.record.files) {
    let reason: string | null = null;
    try {
      const evidence = await asynchronousFileEvidence(safePath(ctx.cwd, `${root}/${file.path}`));
      if (evidence.identity !== file.identity || evidence.hash !== file.hash)
        reason = "Generated file changed since review";
    } catch (error) {
      reason = missing(error)
        ? "Generated file is absent"
        : "Generated file cannot be safely verified";
    }
    files.push({ ...file, reason });
  }
  const release = tryAcquireBuildMutationLock(ctx);
  if (!release) return null;
  try {
    if (validReviewedState(ctx, contextKey, true)?.token !== previous.token) return null;
    const stale = new Set(files.filter((file) => file.reason !== null).map((file) => file.path));
    if (stale.size > 0) {
      previous = writeReview(ctx, {
        ...previous.record,
        files: previous.record.files.filter((file) => !stale.has(file.path)),
      });
      if (previous.record.files.length === 0) return null;
    }
    return { token: previous.token, lastUsedAt: previous.record.lastUsedAt, files };
  } catch {
    return null;
  } finally {
    release();
  }
}

/** The reviewed adapter consumes exact selected identities through the compiler's native removal seam. */
export async function removeReviewedBuildFilesAsync(
  worktreePath: string,
  root: string,
  contextKey: string,
  expectedToken: string,
  paths: readonly string[],
  revalidate: (paths: readonly string[]) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build review requires a linked worktree");
  let current = openReviewedState(ctx, contextKey);
  if (!current || current.token !== expectedToken)
    throw new Error("Build review changed before removal");
  const authority: RemovalAuthority = {
    files: current.record.files,
    changedReason: "Generated file changed since review",
    validate: () => {
      try {
        return validReviewedState(ctx, contextKey, true)?.token === current?.token
          ? null
          : "Build review changed before removal";
      } catch {
        return "Build review changed before removal";
      }
    },
    consume: (files) => {
      const consumed = new Set(files.map((file) => file.path));
      current = writeReview(ctx, {
        ...current!.record,
        files: current!.record.files.filter((file) => !consumed.has(file.path)),
      });
    },
  };
  return removeAuthorizedFilesAsync(ctx, authority, paths, revalidate, signal);
}
