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
function readRecord(ctx: Context) {
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
  if (signature(NodeFS.lstatSync(ctx.recordPath)) !== signature(stat))
    throw new Error("Build ownership changed during observation");
  return {
    record: value as BuildRecord,
    recordIdentity: signature(stat),
    token: NodeCrypto.createHash("sha256").update(raw).update(signature(stat)).digest("hex"),
  };
}
const ownershipSnapshot = (previous: ReturnType<typeof readRecord>) =>
  previous === null
    ? null
    : JSON.stringify({
        version: previous.record.version,
        worktreeIdentity: previous.record.worktreeIdentity,
        root: previous.record.root,
        files: previous.record.files,
        emissions: previous.record.emissions,
      });

function writeRecord(ctx: Context, record: BuildRecord, expectedIdentity?: string) {
  const raw = JSON.stringify(record);
  if (record.files.length > MAX_FILES || Buffer.byteLength(raw) > MAX_RECORD_BYTES)
    throw new Error("Build ownership exceeds its observation limit");
  const temporary = `${ctx.recordPath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
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
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous) return false;
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
  let initial = readRecord(ctx);
  const directory = NodeFS.mkdtempSync(NodePath.join(ctx.gitDir, "t3-build-stage-"));
  const initialAllocation = allocation(NodeFS.lstatSync(directory));
  let finished = false;
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
      const initialOwnership = ownershipSnapshot(initial);
      if (ownershipSnapshot(readRecord(ctx)) !== initialOwnership)
        throw new Error("Another build changed output ownership");
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
      const priorFiles = new Map(initial?.record.files.map((file) => [file.path, file]) ?? []);
      const nextFiles = new Map<string, OwnedFile>();
      const emittedPaths = new Set(emitted.map((file) => file.path));
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
      for (const { file, destination, prior, skip } of plans) {
        if (skip) continue; // Identical unknown bytes remain unowned; do not adopt them.
        safePath(ctx.cwd, `${root}/${file.path}`);
        if (prior ? !evidenceMatches(prior, destination) : NodeFS.existsSync(destination))
          throw new Error("Build destination changed during publication");
        NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
        // wx also prevents unexpected files appearing in newly emitted destinations.
        if (prior) NodeFS.unlinkSync(destination);
        NodeFS.copyFileSync(file.source, destination, NodeFS.constants.COPYFILE_EXCL);
        NodeFS.chmodSync(destination, file.mode);
        nextFiles.set(file.path, { path: file.path, ...fileEvidence(destination) });
      }
      const latest = readRecord(ctx);
      if (ownershipSnapshot(latest) !== initialOwnership)
        throw new Error("Another build changed output ownership");
      writeRecord(ctx, {
        version: 1,
        worktreeIdentity: ctx.worktreeIdentity,
        root,
        lastUsedAt: Math.max(now, latest?.record.lastUsedAt ?? 0),
        files: [...nextFiles.values()],
        emissions: emitted.map(({ path, hash }) => ({ path, hash })),
      });
      initial = readRecord(ctx);
      // Retire old chunks only after every destination collision was admitted,
      // current emissions were installed, and their ownership was persisted.
      // Edited/unknown additions stay on disk but cannot accumulate in the ledger.
      const publishedOwnership = ownershipSnapshot(initial);
      let publishedIdentity = initial!.recordIdentity;
      const checkPublishedOwnership = () => {
        if (signature(NodeFS.lstatSync(ctx.recordPath)) !== publishedIdentity) {
          const current = readRecord(ctx);
          if (ownershipSnapshot(current) !== publishedOwnership)
            throw new Error("Another build changed output ownership");
          publishedIdentity = current!.recordIdentity; // Timestamp-only use renewal is allowed.
        }
      };
      for (const file of priorFiles.values()) {
        if (emittedPaths.has(file.path)) continue;
        checkPublishedOwnership();
        let destination;
        try {
          destination = safePath(ctx.cwd, `${root}/${file.path}`);
          if (!evidenceMatches(file, destination)) continue;
        } catch {
          continue; // Missing or no longer verifiable historical outputs remain unowned.
        }
        checkPublishedOwnership();
        NodeFS.unlinkSync(destination);
        let parent = NodePath.dirname(destination);
        const output = NodePath.join(ctx.cwd, root);
        while (parent.startsWith(`${output}${NodePath.sep}`) || parent === output) {
          try {
            NodeFS.rmdirSync(parent);
          } catch {
            break;
          }
          parent = NodePath.dirname(parent);
        }
      }
      initial = readRecord(ctx);
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
