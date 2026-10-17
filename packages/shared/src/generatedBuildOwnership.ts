// @effect-diagnostics nodeBuiltinImport:off -- Also used by dependency-free build runners.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

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
    // Best-effort native admission immediately before replacement. Usage must
    // not overwrite an ownership generation published while its temp was written.
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

/** Hash bounded batches, then refresh policy/consumers once per batch before synchronous final identity checks. */
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
  const previous = readRecord(ctx);
  if (!previous || previous.token !== expectedToken)
    throw new Error("Build ownership changed before removal");
  const owned = new Map(previous.record.files.map((file) => [file.path, file]));
  const requested = [...new Set(paths)].map((path) => {
    const file = owned.get(path);
    if (!file) throw new Error("Requested file has no emission provenance");
    return file;
  });
  let bytes = 0;
  let files = 0;
  const kept: Array<{ path: string; reason: string }> = [];
  const stop = (offset: number, reason: string) => {
    const alreadyKept = new Set(kept.map(({ path }) => path));
    kept.push(
      ...requested
        .slice(offset)
        .filter(({ path }) => !alreadyKept.has(path))
        .map(({ path }) => ({ path, reason })),
    );
    return { bytes, files, kept };
  };
  for (let offset = 0; offset < requested.length; offset += 64) {
    if (signal?.aborted) return stop(offset, "Build cleanup was cancelled");
    const batch = requested.slice(offset, offset + 64);
    const verified = new Set<string>();
    for (const file of batch) {
      if (signal?.aborted) return stop(offset, "Build cleanup was cancelled");
      try {
        const current = await asynchronousFileEvidence(
          safePath(ctx.cwd, `${root}/${file.path}`),
          signal,
        );
        if (current.identity === file.identity && current.hash === file.hash)
          verified.add(file.path);
        else kept.push({ path: file.path, reason: "Generated file changed since emission" });
      } catch (error) {
        kept.push({
          path: file.path,
          reason: missing(error)
            ? "Generated file is absent"
            : "Generated file cannot be safely verified",
        });
      }
    }
    if (verified.size === 0) continue;
    if (signal?.aborted) return stop(offset, "Build cleanup was cancelled");
    if (!(await revalidate([...verified])))
      return stop(offset, "Build cleanup guards changed before removal");
    if (hasPendingPublication(ctx)) return stop(offset, "Build publication is pending recovery");
    for (const [index, file] of batch.entries()) {
      if (!verified.has(file.path)) continue;
      if (signal?.aborted) return stop(offset + index, "Build cleanup was cancelled");
      try {
        if (signature(NodeFS.lstatSync(ctx.recordPath)) !== previous.recordIdentity)
          return stop(offset + index, "Build ownership changed before removal");
        const target = safePath(ctx.cwd, `${root}/${file.path}`);
        const stat = NodeFS.lstatSync(target);
        // Async hashing is accepted only while inode, immutable ctime, size and
        // timestamps still match. No content hashing or await in this final seam.
        if (!stat.isFile() || stat.nlink !== 1 || signature(stat) !== file.identity) {
          kept.push({ path: file.path, reason: "Generated file changed before removal" });
          continue;
        }
        NodeFS.unlinkSync(target);
        bytes += file.bytes;
        files++;
        let parent = NodePath.dirname(target);
        const output = NodePath.join(ctx.cwd, root);
        while (parent.startsWith(`${output}${NodePath.sep}`) || parent === output) {
          try {
            NodeFS.rmdirSync(parent);
          } catch {
            break;
          }
          parent = NodePath.dirname(parent);
        }
      } catch (error) {
        kept.push({
          path: file.path,
          reason: missing(error)
            ? "Generated file is absent"
            : "Generated file could not be removed safely",
        });
      }
    }
  }
  return { bytes, files, kept };
}

/** Only positive evidence of an actual compiled-output consumer may renew this clock. */
export function recordGeneratedBuildUse(worktreePath: string, root: string, now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid build use time");
  const ctx = context(worktreePath, root);
  if (!ctx || hasPendingPublication(ctx)) return false;
  const previous = readRecord(ctx);
  if (!previous) return false;
  return writeRecord(
    ctx,
    { ...previous.record, lastUsedAt: Math.max(now, previous.record.lastUsedAt) },
    previous.recordIdentity,
  );
}

/** Exact selective deletion only. Keep provenance and approvals, including after partial removal or regeneration. */
export function removeGeneratedBuildFiles(
  worktreePath: string,
  root: string,
  expectedToken: string,
  paths: readonly string[],
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build ownership requires a linked worktree");
  const previous = readRecord(ctx);
  if (!previous || previous.token !== expectedToken)
    throw new Error("Build ownership changed before removal");
  const owned = new Map(previous.record.files.map((file) => [file.path, file]));
  let bytes = 0;
  let files = 0;
  const kept: Array<{ path: string; reason: string }> = [];
  for (const relative of new Set(paths)) {
    const file = owned.get(relative);
    if (!file) throw new Error("Requested file has no emission provenance");
    const target = safePath(ctx.cwd, `${root}/${relative}`);
    try {
      if (signature(NodeFS.lstatSync(ctx.recordPath)) !== previous.recordIdentity)
        throw new Error("Build ownership changed before removal");
      if (!evidenceMatches(file, target)) {
        kept.push({ path: relative, reason: "Generated file changed since emission" });
        continue;
      }
      assertNoPendingPublication(ctx);
      // No async gap after the caller's guards and this final identity/content check.
      NodeFS.unlinkSync(target);
      bytes += file.bytes;
      files++;
      let parent = NodePath.dirname(target);
      const output = NodePath.join(ctx.cwd, root);
      while (parent.startsWith(`${output}${NodePath.sep}`) || parent === output) {
        try {
          NodeFS.rmdirSync(parent);
        } catch (error) {
          if (
            ["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
          )
            break;
          break; // Empty-directory pruning is optional after a successful unlink.
        }
        parent = NodePath.dirname(parent);
      }
    } catch (error) {
      if (missing(error)) {
        kept.push({ path: relative, reason: "Generated file is absent" });
        continue;
      }
      throw error;
    }
  }
  return { bytes, files, kept };
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
    NodeFS.rmSync(directory, { recursive: true }); // Only the fresh, runner-owned stage, never an actual output root.
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
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous)
    throw new Error("Web build has no emission provenance; rebuild the web app first");
  // Historical owned chunks remain eligible for cleanup, but only the latest
  // compiler emission belongs in a newly built server client bundle.
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
}
