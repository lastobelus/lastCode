// @effect-diagnostics nodeBuiltinImport:off -- Also used by dependency-free build runners.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Crypto from "node:crypto";

type OwnedFile = { path: string; identity: string; hash: string; bytes: number };
type BuildRecord = {
  version: 1; worktreeIdentity: string; root: string; lastUsedAt: number;
  files: OwnedFile[]; emissions: Array<{ path: string; hash: string }>;
};
const MAX_FILES = 50_000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const signature = (stat: FS.Stats) => JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs, stat.size]);
const allocation = (stat: FS.Stats) => JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const allowedRoot = (root: string) => /^apps\/[a-zA-Z0-9_-]+\/dist$/.test(root) || root === "native/resource-monitor/target/debug";
const safeRelative = (path: string) => path.length > 0 && !/[\\:\x00-\x1f]/.test(path) && !Path.posix.isAbsolute(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function context(worktreePath: string, root: string) {
  if (!allowedRoot(root)) throw new Error("Unrecognized generated build root");
  const cwd = FS.realpathSync(worktreePath);
  const gitFile = Path.join(cwd, ".git");
  let stat;
  try { stat = FS.lstatSync(gitFile); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (stat.isDirectory()) return null;
  if (!stat.isFile() || stat.size > 4096) throw new Error("Unsafe worktree metadata");
  const contents = FS.readFileSync(gitFile, "utf8").trim();
  if (!contents.startsWith("gitdir: ") || contents.includes("\n")) throw new Error("Invalid worktree metadata");
  const gitDir = FS.realpathSync(Path.resolve(cwd, contents.slice(8)));
  const worktreeIdentity = `${cwd}:${allocation(FS.lstatSync(cwd))}`;
  const recordPath = Path.join(gitDir, `t3-build-${Crypto.createHash("sha256").update(root).digest("hex")}.json`);
  return { cwd, gitDir, root, recordPath, worktreeIdentity };
}
type Context = NonNullable<ReturnType<typeof context>>;

/** Every existing component must be a real directory; neither links nor files may redirect a build path. */
function safePath(base: string, relative: string) {
  if (!safeRelative(relative)) throw new Error("Unsafe generated file path");
  let ancestor = base;
  while (true) {
    try {
      const stat = FS.lstatSync(ancestor);
      if (!stat.isDirectory() || FS.realpathSync(ancestor) !== ancestor) throw new Error("Linked or invalid generated path");
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = Path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const parts = relative.split("/");
  let target = base;
  for (const [index, part] of parts.entries()) {
    target = Path.join(target, part);
    try {
      const stat = FS.lstatSync(target);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error("Linked or invalid generated path");
    } catch (error) { if (!missing(error)) throw error; }
  }
  return target;
}
function fileEvidence(target: string, allowStageHardlinks = false) {
  const before = FS.lstatSync(target);
  if (!before.isFile() || (!allowStageHardlinks && before.nlink !== 1)) throw new Error("Generated output is not an exclusive regular file");
  const hash = Crypto.createHash("sha256").update(FS.readFileSync(target)).digest("hex");
  if (signature(FS.lstatSync(target)) !== signature(before)) throw new Error("Generated output changed during observation");
  return { identity: signature(before), hash, bytes: Number.isFinite(before.blocks) ? before.blocks * 512 : before.size, mode: before.mode };
}
function readRecord(ctx: Context) {
  let stat;
  try { stat = FS.lstatSync(ctx.recordPath); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD_BYTES) throw new Error("Unsafe build ownership record");
  const raw = FS.readFileSync(ctx.recordPath, "utf8");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
    !("worktreeIdentity" in value) || value.worktreeIdentity !== ctx.worktreeIdentity || !("root" in value) || value.root !== ctx.root ||
    !("lastUsedAt" in value) || typeof value.lastUsedAt !== "number" || !Number.isSafeInteger(value.lastUsedAt) || value.lastUsedAt < 0 ||
    !("emissions" in value) || !Array.isArray(value.emissions) || value.emissions.length > MAX_FILES ||
    !("files" in value) || !Array.isArray(value.files) || value.files.length > MAX_FILES) throw new Error("Invalid build ownership record");
  const paths = new Set<string>();
  for (const file of value.files) {
    if (typeof file !== "object" || file === null || typeof file.path !== "string" || !safeRelative(file.path) || paths.has(file.path) ||
      typeof file.identity !== "string" || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash) ||
      typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("Invalid owned build file");
    paths.add(file.path);
  }
  const emittedPaths = new Set<string>();
  for (const emission of value.emissions) {
    if (typeof emission !== "object" || emission === null || typeof emission.path !== "string" || !safeRelative(emission.path) || emittedPaths.has(emission.path) ||
      typeof emission.hash !== "string" || !/^[a-f0-9]{64}$/.test(emission.hash)) throw new Error("Invalid compiler emission");
    emittedPaths.add(emission.path);
  }
  if (signature(FS.lstatSync(ctx.recordPath)) !== signature(stat)) throw new Error("Build ownership changed during observation");
  return { record: value as BuildRecord, recordIdentity: signature(stat), token: Crypto.createHash("sha256").update(raw).update(signature(stat)).digest("hex") };
}
function writeRecord(ctx: Context, record: BuildRecord) {
  const raw = JSON.stringify(record);
  if (record.files.length > MAX_FILES || Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error("Build ownership exceeds its observation limit");
  const temporary = `${ctx.recordPath}.${Crypto.randomUUID()}.tmp`;
  try {
    FS.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
    FS.renameSync(temporary, ctx.recordPath);
  } finally { FS.rmSync(temporary, { force: true }); }
}
function evidenceMatches(file: OwnedFile, target: string) {
  const current = fileEvidence(target);
  return current.identity === file.identity && current.hash === file.hash;
}

/** Provenance is evidence of emitted bytes, never deletion consent. Caller owns policy, Git, leases and read protection. */
export function inspectGeneratedBuildOwnership(worktreePath: string, root: string) {
  const ctx = context(worktreePath, root);
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous) return null;
  const files = previous.record.files.map((file) => {
    let reason: string | null = null;
    try { if (!evidenceMatches(file, safePath(ctx.cwd, `${root}/${file.path}`))) reason = "Generated file changed since emission"; }
    catch (error) { reason = missing(error) ? "Generated file is absent" : "Generated file cannot be safely verified"; }
    return { ...file, reason };
  });
  return { token: previous.token, lastUsedAt: previous.record.lastUsedAt, files };
}

async function asynchronousFileEvidence(target: string) {
  const before = await FS.promises.lstat(target);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Generated output is not an exclusive regular file");
  const hash = Crypto.createHash("sha256");
  for await (const chunk of FS.createReadStream(target, { flags: FS.constants.O_RDONLY | (FS.constants.O_NOFOLLOW ?? 0) })) hash.update(chunk as Uint8Array);
  if (signature(await FS.promises.lstat(target)) !== signature(before)) throw new Error("Generated output changed during observation");
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
      if (current.identity !== file.identity || current.hash !== file.hash) reason = "Generated file changed since emission";
    } catch (error) { reason = missing(error) ? "Generated file is absent" : "Generated file cannot be safely verified"; }
    files.push({ ...file, reason });
  }
  return { token: previous.token, lastUsedAt: previous.record.lastUsedAt, files };
}

/** Hash bounded batches, then refresh policy/consumers once per batch before synchronous final identity checks. */
export async function removeGeneratedBuildFilesAsync(
  worktreePath: string, root: string, expectedToken: string, paths: readonly string[], revalidate: () => Promise<boolean>,
) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build ownership requires a linked worktree");
  const previous = readRecord(ctx);
  if (!previous || previous.token !== expectedToken) throw new Error("Build ownership changed before removal");
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
    kept.push(...requested.slice(offset).filter(({ path }) => !alreadyKept.has(path)).map(({ path }) => ({ path, reason })));
    return { bytes, files, kept };
  };
  for (let offset = 0; offset < requested.length; offset += 64) {
    const batch = requested.slice(offset, offset + 64);
    const verified = new Set<string>();
    for (const file of batch) {
      try {
        const current = await asynchronousFileEvidence(safePath(ctx.cwd, `${root}/${file.path}`));
        if (current.identity === file.identity && current.hash === file.hash) verified.add(file.path);
        else kept.push({ path: file.path, reason: "Generated file changed since emission" });
      } catch (error) { kept.push({ path: file.path, reason: missing(error) ? "Generated file is absent" : "Generated file cannot be safely verified" }); }
    }
    if (verified.size === 0) continue;
    if (!(await revalidate())) return stop(offset, "Build cleanup guards changed before removal");
    for (const [index, file] of batch.entries()) {
      if (!verified.has(file.path)) continue;
      try {
        if (signature(FS.lstatSync(ctx.recordPath)) !== previous.recordIdentity) return stop(offset + index, "Build ownership changed before removal");
        const target = safePath(ctx.cwd, `${root}/${file.path}`);
        const stat = FS.lstatSync(target);
        // Async hashing is accepted only while inode, immutable ctime, size and
        // timestamps still match. No content hashing or await in this final seam.
        if (!stat.isFile() || stat.nlink !== 1 || signature(stat) !== file.identity) {
          kept.push({ path: file.path, reason: "Generated file changed before removal" });
          continue;
        }
        FS.unlinkSync(target);
        bytes += file.bytes;
        files++;
        let parent = Path.dirname(target);
        const output = Path.join(ctx.cwd, root);
        while (parent.startsWith(`${output}${Path.sep}`) || parent === output) {
          try { FS.rmdirSync(parent); } catch { break; }
          parent = Path.dirname(parent);
        }
      } catch (error) { kept.push({ path: file.path, reason: missing(error) ? "Generated file is absent" : "Generated file could not be removed safely" }); }
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
  writeRecord(ctx, { ...previous.record, lastUsedAt: Math.max(now, previous.record.lastUsedAt) });
  return true;
}

/** Exact selective deletion only. Keep provenance and approvals, including after partial removal or regeneration. */
export function removeGeneratedBuildFiles(worktreePath: string, root: string, expectedToken: string, paths: readonly string[]) {
  const ctx = context(worktreePath, root);
  if (!ctx) throw new Error("Build ownership requires a linked worktree");
  const previous = readRecord(ctx);
  if (!previous || previous.token !== expectedToken) throw new Error("Build ownership changed before removal");
  const owned = new Map(previous.record.files.map((file) => [file.path, file]));
  let bytes = 0;
  let files = 0;
  const kept: Array<{ path: string; reason: string }> = [];
  for (const relative of new Set(paths)) {
    const file = owned.get(relative);
    if (!file) throw new Error("Requested file has no emission provenance");
    const target = safePath(ctx.cwd, `${root}/${relative}`);
    try {
      if (signature(FS.lstatSync(ctx.recordPath)) !== previous.recordIdentity) throw new Error("Build ownership changed before removal");
      if (!evidenceMatches(file, target)) { kept.push({ path: relative, reason: "Generated file changed since emission" }); continue; }
      // No async gap after the caller's guards and this final identity/content check.
      FS.unlinkSync(target);
      bytes += file.bytes;
      files++;
      let parent = Path.dirname(target);
      const output = Path.join(ctx.cwd, root);
      while (parent.startsWith(`${output}${Path.sep}`) || parent === output) {
        try { FS.rmdirSync(parent); } catch (error) {
          if (["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
          break; // Empty-directory pruning is optional after a successful unlink.
        }
        parent = Path.dirname(parent);
      }
    } catch (error) {
      if (missing(error)) { kept.push({ path: relative, reason: "Generated file is absent" }); continue; }
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
  const directory = FS.mkdtempSync(Path.join(ctx.gitDir, "t3-build-stage-"));
  const initialAllocation = allocation(FS.lstatSync(directory));
  let finished = false;
  const discard = () => {
    if (finished) return;
    if (FS.realpathSync(directory) !== directory || allocation(FS.lstatSync(directory)) !== initialAllocation) throw new Error("Build stage changed identity");
    FS.rmSync(directory, { recursive: true }); // Only the fresh, runner-owned stage, never an actual output root.
    finished = true;
  };
  return {
    directory,
    discard,
    publish(now: number, sourceDirectory = directory, retainStage = false) {
      if (finished || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid build publication");
      const source = FS.realpathSync(sourceDirectory);
      if (source !== directory && !source.startsWith(`${directory}${Path.sep}`)) throw new Error("Output is outside the runner-owned stage");
      if (allocation(FS.lstatSync(directory)) !== initialAllocation) throw new Error("Build stage changed identity");
      if (readRecord(ctx)?.token !== initial?.token) throw new Error("Another build changed output ownership");
      const emitted: Array<OwnedFile & { source: string; mode: number }> = [];
      const stageLinks = new Map<string, { count: number; links: number }>();
      const visit = (dir: string, prefix: string) => {
        for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
          const relative = `${prefix}${entry.name}`;
          const target = safePath(source, relative);
          if (entry.isDirectory()) visit(target, `${relative}/`);
          else {
            if (emitted.length >= MAX_FILES) throw new Error("Build emitted too many files");
            const stat = FS.lstatSync(target);
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
      if ([...stageLinks.values()].some((entry) => entry.count !== entry.links)) throw new Error("Build stage contains an external hardlink");
      const priorFiles = new Map(initial?.record.files.map((file) => [file.path, file]) ?? []);
      const plans = emitted.map((file) => {
        const destination = safePath(ctx.cwd, `${root}/${file.path}`);
        try {
          const existing = fileEvidence(destination);
          const prior = priorFiles.get(file.path);
          if (prior && existing.identity === prior.identity && existing.hash === prior.hash) return { file, destination, prior, skip: false };
          if (existing.hash === file.hash) return { file, destination, prior: undefined, skip: true };
          throw new Error(`Build output collision requires file review: ${root}/${file.path}`);
        } catch (error) { if (missing(error)) return { file, destination, prior: undefined, skip: false }; throw error; }
      });
      for (const { file, destination, prior, skip } of plans) {
        if (skip) continue; // Identical unknown bytes remain unowned; do not adopt them.
        safePath(ctx.cwd, `${root}/${file.path}`);
        if (prior ? !evidenceMatches(prior, destination) : FS.existsSync(destination)) throw new Error("Build destination changed during publication");
        FS.mkdirSync(Path.dirname(destination), { recursive: true });
        // wx also prevents unexpected files appearing in newly emitted destinations.
        if (prior) FS.unlinkSync(destination);
        FS.copyFileSync(file.source, destination, FS.constants.COPYFILE_EXCL);
        FS.chmodSync(destination, file.mode);
        priorFiles.set(file.path, { path: file.path, ...fileEvidence(destination) });
      }
      writeRecord(ctx, { version: 1, worktreeIdentity: ctx.worktreeIdentity, root, lastUsedAt: Math.max(now, initial?.record.lastUsedAt ?? 0), files: [...priorFiles.values()], emissions: emitted.map(({ path, hash }) => ({ path, hash })) });
      initial = readRecord(ctx);
      if (!retainStage) discard();
    },
  };
}

/** Copy only the latest verified compiler emissions, never arbitrary additions in the real dist tree. */
export function copyOwnedGeneratedBuild(worktreePath: string, root: string, destination: string) {
  const ctx = context(worktreePath, root);
  const previous = ctx && readRecord(ctx);
  if (!ctx || !previous) throw new Error("Web build has no emission provenance; rebuild the web app first");
  // Historical owned chunks remain eligible for cleanup, but only the latest
  // compiler emission belongs in a newly built server client bundle.
  for (const file of previous.record.emissions) {
    const source = safePath(ctx.cwd, `${root}/${file.path}`);
    if (fileEvidence(source).hash !== file.hash) throw new Error("Web output changed since compiler emission");
    const target = safePath(destination, file.path);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.copyFileSync(source, target, FS.constants.COPYFILE_EXCL);
    if (fileEvidence(target).hash !== file.hash) throw new Error("Web output changed during server build");
  }
}
