// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This Node-only durable store is called by the server Effect service and owns native file descriptors.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import * as HostProcess from "./HostProcess.ts";

const DEFAULT_WORKTREE_SUSPENSION_LIMITS = {
  maxEntries: 100_000,
  maxBytes: 512 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  reserveBytes: 256 * 1024 * 1024,
} as const;

export interface WorktreeSuspensionLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxFileBytes: number;
  readonly reserveBytes: number;
}

export class WorktreeSuspensionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Workspace kept: ${reason}`);
    this.reason = reason;
    this.name = "WorktreeSuspensionError";
  }
}

interface SuspensionMetadata {
  readonly attributes: ReadonlyArray<SuspensionAttribute>;
  readonly hiddenPaths: ReadonlyArray<string>;
}

interface SuspensionAttribute {
  readonly path: string;
  readonly name: string;
  readonly hex: string;
}

// CLI writes must fit the platform argument limit; metadata also has an aggregate budget.
const MAX_ATTRIBUTE_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ATTRIBUTES = 4096;
const supportedAttribute = (name: string) =>
  [
    "com.apple.FinderInfo",
    "com.apple.ResourceFork",
    "com.apple.TextEncoding",
    "com.apple.quarantine",
  ].includes(name) || /^com\.apple\.metadata:[A-Za-z0-9_]+$/u.test(name);

export type SuspensionEntry =
  | { readonly path: string; readonly kind: "directory"; readonly mode: number }
  | {
      readonly path: string;
      readonly kind: "file";
      readonly mode: number;
      readonly size: number;
      readonly hash: string;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly mode: number;
      readonly target: string;
    };

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface SuspensionHardlink {
  readonly path: string;
  readonly target: string;
}

export interface WorktreeSuspensionSnapshot {
  readonly version: 1 | 2 | 3;
  readonly id: string;
  readonly operationId: string;
  readonly ownerBinding: string;
  readonly createdAt: string;
  readonly sourcePath: string;
  readonly sourceIdentity: FileIdentity;
  readonly gitDirectory: string;
  readonly gitDirectoryIdentity: FileIdentity;
  readonly commonDirectory: string;
  readonly commonIdentity: FileIdentity;
  readonly head: string;
  readonly branch: string | null;
  readonly indexTree: string;
  readonly headRef: string;
  readonly indexRef: string;
  readonly attributes?: ReadonlyArray<SuspensionAttribute>;
  readonly hiddenPaths?: ReadonlyArray<string>;
  readonly hardlinks?: ReadonlyArray<SuspensionHardlink>;
  readonly rootMode: number;
  readonly rootUid: number;
  readonly rootGid: number;
  readonly entries: ReadonlyArray<SuspensionEntry>;
  readonly rawBytes: number;
  readonly savedBytes: number;
  readonly gitFiles: ReadonlyArray<SuspensionEntry>;
  readonly gitRefs: ReadonlyArray<
    { readonly ref: string; readonly object: string } & (
      | { readonly type: "commit" | "tag" }
      | { readonly type: "tree"; readonly source: "AUTO_MERGE" }
    )
  >;
}

export type WorktreeSuspensionPhase =
  | "capturing"
  | "capture-cleanup"
  | "capture-cancelled"
  | "verifying"
  | "ready"
  | "isolating"
  | "isolated"
  | "removing"
  | "suspended"
  | "restoring"
  | "restored"
  | "active"
  | "discard-intent"
  | "discarding"
  | "discarded";

export interface WorktreeSuspensionJournal {
  readonly version: 1;
  readonly snapshotId: string;
  readonly operationId: string;
  readonly phase: WorktreeSuspensionPhase;
  readonly sourcePath?: string;
  readonly sourceIdentity?: FileIdentity;
  readonly isolatedPath?: string;
  readonly restorePath?: string;
  readonly destinationPath?: string;
  readonly restoreIdentity?: FileIdentity;
  readonly restoreGitDirectory?: string;
  readonly restoreContainerIdentity?: FileIdentity;
  readonly trialPath?: string;
  readonly trialIdentity?: FileIdentity;
  readonly trialGitDirectory?: string;
  readonly requestedBranch?: string | null;
  readonly requestedBranchExplicit?: boolean;
  readonly branch?: string;
  readonly discardPreviousPhase?: "active" | "suspended";
  readonly captureRefs?: Pick<
    WorktreeSuspensionSnapshot,
    "commonDirectory" | "commonIdentity" | "headRef" | "head" | "indexRef" | "indexTree" | "gitRefs"
  >;
  readonly discard?: Pick<
    WorktreeSuspensionSnapshot,
    "commonDirectory" | "commonIdentity" | "headRef" | "head" | "indexRef" | "indexTree" | "gitRefs"
  >;
}

export interface WorktreeSuspensionStoreOptions {
  readonly storeRoot: string;
  readonly limits?: Partial<WorktreeSuspensionLimits>;
  /** Failure injection occurs only after the named boundary is durable. */
  readonly onBoundary?: (phase: WorktreeSuspensionPhase, snapshotId: string) => Promise<void>;
}

function refuse(reason: string): never {
  throw new WorktreeSuspensionError(reason);
}
const identity = (stat: { dev: number; ino: number }): FileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
});
const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
const within = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}${NodePath.sep}`);
const validId = (id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) refuse("invalid snapshot identity");
  return id;
};
const validRelativePath = (name: string) => {
  if (
    name === "" ||
    NodePath.isAbsolute(name) ||
    name
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part === ".git") ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\ufffd",
    ) ||
    Buffer.from(name).toString("utf8") !== name
  ) {
    refuse("a filename cannot be represented safely");
  }
};
const exists = async (name: string) => {
  try {
    await NodeFSP.lstat(name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const command = (
  program: string,
  args: ReadonlyArray<string>,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input?: string,
  maxBuffer = 64 * 1024 * 1024,
) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      program,
      [...args],
      { cwd, env, encoding: "buffer", maxBuffer },
      (error, stdout) => {
        if (error) {
          reject(
            new WorktreeSuspensionError(
              `${NodePath.basename(program)} could not complete verification`,
            ),
          );
        } else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

const gitEnvironment = () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
};
const gitArguments = (args: ReadonlyArray<string>) => [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "core.fsync=loose-object,reference",
  "-c",
  "core.fsyncMethod=fsync",
  ...args,
];
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  extraEnv?: NodeJS.ProcessEnv,
  input?: string,
) => command("git", gitArguments(args), cwd, { ...gitEnvironment(), ...extraEnv }, input);
const gitText = async (cwd: string, args: ReadonlyArray<string>, extraEnv?: NodeJS.ProcessEnv) =>
  (await git(cwd, args, extraEnv)).toString("utf8").trim();

interface GitPayload {
  readonly hash: string;
  readonly bytes: Buffer;
}

const matchingGitPayload = (
  entry: Extract<SuspensionEntry, { kind: "file" }>,
  payloads?: ReadonlyMap<string, GitPayload>,
) => {
  const payload = payloads?.get(entry.path);
  return payload?.hash === entry.hash && payload.bytes.length === entry.size ? payload : undefined;
};

const verifyGitObjects = async (
  snapshot: Pick<
    WorktreeSuspensionSnapshot,
    "commonDirectory" | "head" | "indexTree" | "gitRefs" | "entries"
  >,
  limits: WorktreeSuspensionLimits,
) => {
  const headTree = await gitText(snapshot.commonDirectory, [
    "rev-parse",
    `${snapshot.head}^{tree}`,
  ]);
  const objects = new Map<string, string>([
    [snapshot.head, "commit"],
    [snapshot.indexTree, "tree"],
    [headTree, "tree"],
  ]);
  for (const ref of snapshot.gitRefs) objects.set(ref.object, ref.type);
  const expectedFiles = new Map(
    snapshot.entries.flatMap((entry) =>
      entry.kind === "file" ? [[entry.path, entry] as const] : [],
    ),
  );
  const indexBlobs = new Map<string, Array<Extract<SuspensionEntry, { kind: "file" }>>>();
  for (const tree of new Set([
    snapshot.indexTree,
    headTree,
    ...snapshot.gitRefs.filter((ref) => ref.type === "tree").map((ref) => ref.object),
  ])) {
    const listing = await git(snapshot.commonDirectory, [
      "ls-tree",
      "-r",
      "-t",
      "-z",
      "--long",
      tree,
    ]);
    let stagedBytes = 0;
    let entryCount = 0;
    for (const line of listing.toString("utf8").split("\0")) {
      if (line === "") continue;
      const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+) +([\d-]+)\t(.+)$/u.exec(line);
      if (match === null) refuse("the staged tree contains unsupported entries");
      validRelativePath(match![5]!);
      const size = match![4] === "-" ? 0 : Number(match![4]);
      stagedBytes += size;
      entryCount += 1;
      if (
        size > limits.maxFileBytes ||
        stagedBytes > limits.maxBytes ||
        entryCount > limits.maxEntries
      )
        refuse("the staging area exceeds preservation limits");
      if (match![2] === "commit") {
        if (match![1] !== "160000") refuse("the staged tree contains unsupported entries");
      } else {
        objects.set(match![3]!, match![2]!);
        const expected = expectedFiles.get(match![5]!);
        if (tree === snapshot.indexTree && match![2] === "blob" && expected?.size === size) {
          const entries = indexBlobs.get(match![3]!) ?? [];
          entries.push(expected);
          indexBlobs.set(match![3]!, entries);
        }
      }
    }
  }
  const requests = [...objects];
  const child = NodeChildProcess.spawn("git", gitArguments(["cat-file", "--batch"]), {
    cwd: snapshot.commonDirectory,
    env: gitEnvironment(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(new WorktreeSuspensionError("Git objects could not be verified")),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new WorktreeSuspensionError("Git objects are missing or corrupt")),
    );
  });
  let request = 0;
  let header = Buffer.alloc(0);
  const indexPayloads = new Map<string, GitPayload>();
  let retainedBytes = 0;
  let current:
    | {
        remaining: number;
        hash: ReturnType<typeof NodeCrypto.createHash>;
        oid: string;
        chunks?: Array<Buffer>;
        size: number;
      }
    | undefined;
  let newline = false;
  let totalBytes = 0;
  const finishObject = () => {
    if (current === undefined) refuse("Git object verification was incomplete");
    if (current.hash.digest("hex") !== current.oid) refuse("a pinned Git object is corrupt");
    if (current.chunks !== undefined) {
      const bytes = Buffer.concat(current.chunks, current.size);
      const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const matching = indexBlobs.get(current.oid)!.filter((entry) => entry.hash === hash);
      if (matching.length > 0) {
        retainedBytes += bytes.length;
        for (const entry of matching) indexPayloads.set(entry.path, { hash, bytes });
      }
    }
    current = undefined;
    request += 1;
    newline = true;
  };
  const output = async () => {
    for await (const raw of child.stdout) {
      const chunk = raw as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (current !== undefined) {
          const length = Math.min(current.remaining, chunk.length - offset);
          current.hash.update(chunk.subarray(offset, offset + length));
          current.chunks?.push(Buffer.from(chunk.subarray(offset, offset + length)));
          current.remaining -= length;
          offset += length;
          if (current.remaining === 0) {
            finishObject();
          }
          continue;
        }
        if (newline) {
          if (chunk[offset] !== 10) refuse("Git object verification was incomplete");
          offset += 1;
          newline = false;
          continue;
        }
        const end = chunk.indexOf(10, offset);
        if (end === -1) {
          header = Buffer.concat([header, chunk.subarray(offset)]);
          if (header.length > 256) refuse("Git object verification was incomplete");
          break;
        }
        const line = Buffer.concat([header, chunk.subarray(offset, end)]).toString("ascii");
        header = Buffer.alloc(0);
        offset = end + 1;
        const [oid, type, rawSize] = line.split(" ");
        const expected = requests[request];
        const size = Number(rawSize);
        totalBytes += size;
        if (
          expected === undefined ||
          oid !== expected[0] ||
          type !== expected[1] ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > limits.maxFileBytes ||
          totalBytes > limits.maxBytes * 2 + 64 * 1024 * 1024
        )
          refuse("Git objects are missing, corrupt, or exceed limits");
        const hash = NodeCrypto.createHash(oid!.length === 40 ? "sha1" : "sha256");
        hash.update(`${type} ${size}\0`);
        const retain = type === "blob" && indexBlobs.has(oid!);
        if (retain && retainedBytes + size > limits.maxBytes)
          refuse("the Git-backed payloads exceed preservation limits");
        current = { remaining: size, hash, oid: oid!, size, ...(retain ? { chunks: [] } : {}) };
        if (size === 0) {
          finishObject();
        }
      }
    }
    if (request !== requests.length || current !== undefined || newline || header.length !== 0)
      refuse("Git object verification was incomplete");
  };
  try {
    await Promise.all([
      NodeStreamPromises.pipeline(
        NodeStream.Readable.from(requests.map(([oid]) => `${oid}\n`)),
        child.stdin,
      ),
      output(),
      completed,
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await completed.catch(() => undefined);
  }
  return { objects: [...objects.keys()], indexPayloads };
};

const syncFile = async (name: string) => {
  const file = await NodeFSP.open(name, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};
const syncDirectory = syncFile;

// Independent file flushes may overlap, but no durable phase can outlive its pending flushes.
const durabilityBatch = () => {
  const pending: Array<Promise<void>> = [];
  let failure: { readonly cause: unknown } | undefined;
  const drain = async () => {
    await Promise.all(pending.splice(0));
    if (failure !== undefined) throw failure.cause;
  };
  return {
    async add(operation: () => Promise<void>) {
      if (failure !== undefined) throw failure.cause;
      pending.push(
        operation().catch((cause: unknown) => {
          failure ??= { cause };
        }),
      );
      if (pending.length >= 8) await drain();
    },
    drain,
  };
};

const syncGitObjects = async (
  commonDirectory: string,
  objects: ReadonlyArray<string>,
  limits: WorktreeSuspensionLimits,
) => {
  const root = NodePath.join(commonDirectory, "objects");
  const directories = new Set<string>([root, commonDirectory]);
  const durable = durabilityBatch();
  let packed = false;
  try {
    for (const object of objects) {
      const filename = NodePath.join(root, object.slice(0, 2), object.slice(2));
      if (await exists(filename)) {
        await noLinkedAncestors(NodePath.dirname(filename));
        await durable.add(() => syncFile(filename));
        directories.add(NodePath.dirname(filename));
      } else packed = true;
    }
    if (packed) {
      const packRoot = NodePath.join(root, "pack");
      await noLinkedAncestors(packRoot);
      const names = await NodeFSP.readdir(packRoot);
      if (names.length > limits.maxEntries)
        refuse("the Git pack inventory exceeds preservation limits");
      for (const name of names) {
        const filename = NodePath.join(packRoot, name);
        if (!(await NodeFSP.lstat(filename)).isFile())
          refuse("the Git pack inventory has unsupported entries");
        await durable.add(() => syncFile(filename));
      }
      directories.add(packRoot);
    }
  } finally {
    await durable.drain();
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    await syncDirectory(directory);
};

const noLinkedAncestors = async (name: string) => {
  const absolute = NodePath.resolve(name);
  let current = NodePath.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, part);
    const stat = await NodeFSP.lstat(current);
    if (stat.isSymbolicLink()) refuse("a path ancestor is redirected");
    if (!stat.isDirectory()) refuse("a path ancestor is not a directory");
  }
};

const privateDirectory = async (name: string) => {
  const parent = NodePath.dirname(name);
  await noLinkedAncestors(parent);
  try {
    await NodeFSP.mkdir(name, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await NodeFSP.lstat(name);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    refuse("the private store is not owned and private");
  await metadataCheck(name, [], false);
};

const atomicJson = async (name: string, value: unknown) => {
  const temporary = `${name}.${NodeCrypto.randomUUID()}.tmp`;
  const file = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await NodeFSP.rename(temporary, name);
  await syncDirectory(NodePath.dirname(name));
};

const metadataCheck = async (
  root: string,
  entries: ReadonlyArray<SuspensionEntry>,
  recursive = true,
  attributeLimits?: WorktreeSuspensionLimits,
): Promise<SuspensionMetadata> => {
  if (HostProcess.Platform.defaultValue() === "darwin") {
    const attributes = await command("/usr/bin/xattr", [recursive ? "-rs" : "-s", root]);
    const captured: Array<SuspensionAttribute> = [];
    const paths = new Set(["", ...entries.map((entry) => entry.path)]);
    let metadataBytes = 0;
    const text = attributes.toString("utf8");
    if (!Buffer.from(text).equals(attributes)) refuse("extended attribute names are unsupported");
    for (const line of text.split("\n").filter(Boolean).sort()) {
      const separator = recursive ? line.lastIndexOf(": ") : -1;
      const absolute = recursive ? line.slice(0, separator) : root;
      const name = recursive ? line.slice(separator + 2) : line;
      const path = NodePath.relative(root, absolute);
      if (
        (recursive && separator < 0) ||
        !NodePath.isAbsolute(absolute) ||
        NodePath.isAbsolute(path) ||
        path === ".." ||
        path.startsWith(`..${NodePath.sep}`)
      )
        refuse("extended attribute paths could not be verified");
      // macOS manages this application-identity tag, including on private Git
      // and store files. Writes may succeed without changing it; leave it to
      // the OS rather than replaying a saved application's provenance identity.
      if (name === "com.apple.provenance") continue;
      if (attributeLimits === undefined || !paths.has(path) || !supportedAttribute(name))
        refuse(`extended attributes are unsupported (${name} at ${absolute})`);
      if (captured.length >= MAX_ATTRIBUTES) refuse("extended attributes exceed the record limit");
      const value = await command(
        "/usr/bin/xattr",
        ["-spx", name, absolute],
        undefined,
        undefined,
        undefined,
        MAX_ATTRIBUTE_BYTES * 4,
      );
      const hex = value.toString("ascii").replace(/\s/gu, "").toLowerCase();
      if (!/^(?:[a-f0-9]{2})*$/u.test(hex) || hex.length > MAX_ATTRIBUTE_BYTES * 2)
        refuse("extended attributes exceed the value limit or are invalid");
      metadataBytes += hex.length / 2 + Buffer.byteLength(name) + Buffer.byteLength(path);
      if (metadataBytes > Math.min(MAX_METADATA_BYTES, attributeLimits!.maxBytes))
        refuse("extended attributes exceed the byte limit");
      captured.push({ path, name, hex });
    }
    const listing = recursive ? await command("/bin/ls", ["-lAnReO", "--", root]) : Buffer.alloc(0);
    const rootListing = await command("/bin/ls", ["-ldneO", "--", root]);
    let hasHidden = false;
    for (const line of Buffer.concat([listing, rootListing]).toString("utf8").split("\n")) {
      if (!/^[bcdlps-][rwxStTs-]{9}/u.test(line)) continue;
      const fields = line.trim().split(/\s+/u);
      if (
        fields[0]?.includes("+") ||
        (fields[4] !== "-" && !(attributeLimits !== undefined && fields[4] === "hidden"))
      ) {
        refuse("ACLs or filesystem flags are unsupported");
      }
      hasHidden ||= fields[4] === "hidden";
    }
    const hiddenPaths: string[] = [];
    if (hasHidden) {
      const flagPaths = new Set(paths);
      if (recursive && (await exists(NodePath.join(root, ".git")))) flagPaths.add(".git");
      let batch: string[] = [];
      let argumentBytes = 0;
      const inspectFlags = async () => {
        if (batch.length === 0) return;
        const values = await command("/usr/bin/stat", [
          "-f",
          "%f",
          "--",
          ...batch.map((name) => NodePath.join(root, name)),
        ]);
        const text = values.toString("utf8");
        const flags = text.trimEnd().split("\n");
        if (!/^(?:[0-9]+\n)+$/u.test(text) || flags.length !== batch.length)
          refuse("filesystem flags could not be verified");
        for (let index = 0; index < batch.length; index++) {
          if (flags[index] === "32768" && batch[index] !== ".git") hiddenPaths.push(batch[index]!);
          else if (flags[index] !== "0") refuse("ACLs or filesystem flags are unsupported");
        }
        batch = [];
        argumentBytes = 0;
      };
      for (const name of flagPaths) {
        const bytes = Buffer.byteLength(NodePath.join(root, name)) + 1;
        if (bytes > 32 * 1024) refuse("a metadata path exceeds inspection limits");
        if (batch.length === 128 || argumentBytes + bytes > 32 * 1024) await inspectFlags();
        batch.push(name);
        argumentBytes += bytes;
      }
      await inspectFlags();
    }
    return { attributes: captured, hiddenPaths };
  }
  if (HostProcess.Platform.defaultValue() === "linux") {
    // Missing platform inspection utilities deliberately keep the original.
    const attributes = await command("getfattr", [
      "-h",
      ...(recursive ? ["-R"] : []),
      "-d",
      "-m",
      "-",
      "--absolute-names",
      "--",
      root,
    ]);
    if (attributes.length !== 0) refuse("extended attributes are unsupported");
    const acls = await command("getfacl", [
      ...(recursive ? ["-R"] : []),
      "-P",
      "-c",
      "-p",
      "-n",
      "--",
      root,
    ]);
    if (
      acls
        .toString("utf8")
        .split("\n")
        .some((line) => line !== "" && !/^(user|group|other)::[rwx-]{3}$/u.test(line))
    ) {
      refuse("ACLs are unsupported");
    }
    // lsattr fails closed on filesystems that cannot report persistent flags.
    const names = [
      root,
      ...entries
        .filter((entry) => entry.kind !== "symlink")
        .map((entry) => NodePath.join(root, entry.path)),
    ];
    for (let offset = 0; offset < names.length; offset += 128) {
      const flags = await command("lsattr", ["-d", "--", ...names.slice(offset, offset + 128)]);
      if (
        flags
          .toString("utf8")
          .split("\n")
          .some((line) => /^[a-zA-Z-]+\s/u.test(line) && /[^e-]/u.test(line.split(/\s/u)[0] ?? ""))
      ) {
        refuse("filesystem flags are unsupported");
      }
    }
    return { attributes: [], hiddenPaths: [] };
  }
  refuse("this platform has no metadata verifier");
};

interface Inventory {
  readonly attributes?: ReadonlyArray<SuspensionAttribute>;
  readonly hiddenPaths?: ReadonlyArray<string>;
  readonly hardlinks?: ReadonlyArray<SuspensionHardlink>;
  readonly entries: ReadonlyArray<SuspensionEntry>;
  readonly rawBytes: number;
  readonly rootMode: number;
  readonly rootIdentity: FileIdentity;
  readonly versions: ReadonlyMap<string, string>;
}

const version = (stat: Awaited<ReturnType<typeof NodeFSP.lstat>>) =>
  `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

const inventory = async (
  root: string,
  limits: WorktreeSuspensionLimits,
  objects?: string,
  selected?: ReadonlySet<string>,
  gitPayloads?: ReadonlyMap<string, GitPayload>,
): Promise<Inventory> => {
  await noLinkedAncestors(root);
  const rootStat = await NodeFSP.lstat(root);
  const entries: Array<SuspensionEntry> = [];
  const versions = new Map<string, string>([[root, version(rootStat)]]);
  const durable = durabilityBatch();
  let rawBytes = 0;
  const files: Array<() => Promise<void>> = [];
  const linkGroups = new Map<string, { count: number; paths: string[] }>();
  const hardlinks: SuspensionHardlink[] = [];
  const inspect = async (directory: string, prefix: string): Promise<void> => {
    const names = (await NodeFSP.readdir(directory, { encoding: "buffer" }))
      .map((name) => {
        const text = name.toString("utf8");
        if (!Buffer.from(text).equals(name)) refuse("a filename is not UTF-8");
        return text;
      })
      .sort();
    for (const name of names) {
      if (prefix === "" && name === ".git") continue;
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (selected !== undefined && !selected.has(relative)) continue;
      validRelativePath(relative);
      if (name === ".git") refuse("nested repositories are unsupported");
      if (entries.length >= limits.maxEntries) refuse("the workspace exceeds the path limit");
      const absolute = NodePath.join(directory, name);
      const before = await NodeFSP.lstat(absolute);
      versions.set(absolute, version(before));
      if (before.dev !== rootStat.dev) refuse("a filesystem boundary crosses the workspace");
      if (before.uid !== rootStat.uid || before.gid !== rootStat.gid)
        refuse("mixed ownership is unsupported");
      if ((before.mode & 0o7000) !== 0) refuse("special permission bits are unsupported");
      if (before.isDirectory()) {
        if (
          (await exists(NodePath.join(absolute, "HEAD"))) &&
          (await exists(NodePath.join(absolute, "objects"))) &&
          (await exists(NodePath.join(absolute, "refs")))
        )
          refuse("nested bare repositories are unsupported");
        entries.push({ path: relative, kind: "directory", mode: before.mode & 0o777 });
        await inspect(absolute, relative);
      } else if (before.isSymbolicLink()) {
        const target = await NodeFSP.readlink(absolute, { encoding: "buffer" });
        if (!Buffer.from(target.toString("utf8")).equals(target)) refuse("a symlink is not UTF-8");
        entries.push({
          path: relative,
          kind: "symlink",
          mode: before.mode & 0o777,
          target: target.toString("utf8"),
        });
      } else if (before.isFile()) {
        if (before.nlink !== 1) {
          // Selected inventories cover private Git files; they cannot certify
          // a complete workspace group and retain the single-link requirement.
          if (selected !== undefined || !Number.isSafeInteger(before.nlink) || before.nlink < 2)
            refuse("hardlinked files are unsupported");
          const key = `${before.dev}:${before.ino}`;
          const group = linkGroups.get(key) ?? { count: before.nlink, paths: [] };
          if (group.count !== before.nlink) refuse("hardlinked files changed during capture");
          group.paths.push(relative);
          linkGroups.set(key, group);
          if (group.paths.length > 1) hardlinks.push({ path: relative, target: group.paths[0]! });
        }
        if (before.size > limits.maxFileBytes) refuse("a file exceeds the preservation limit");
        rawBytes += before.size;
        if (rawBytes > limits.maxBytes) refuse("the workspace exceeds the byte limit");
        const entryIndex = entries.length;
        entries.push({
          path: relative,
          kind: "file",
          mode: before.mode & 0o777,
          size: before.size,
          hash: "",
        });
        files.push(async () => {
          const handle = await NodeFSP.open(
            absolute,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
          const gitPayload = gitPayloads?.get(relative);
          const temporary =
            objects === undefined || gitPayload?.bytes.length === before.size
              ? undefined
              : NodePath.join(objects, `${NodeCrypto.randomUUID()}.tmp`);
          const hash = NodeCrypto.createHash("sha256");
          let readBytes = 0;
          try {
            if (version(await handle.stat()) !== version(before))
              refuse("a file changed during capture");
            const hasher = new NodeStream.Transform({
              transform(chunk: Buffer, _encoding, callback) {
                readBytes += chunk.length;
                if (readBytes > limits.maxFileBytes || readBytes > before.size) {
                  callback(new WorktreeSuspensionError("a file changed during capture"));
                } else {
                  hash.update(chunk);
                  callback(null, chunk);
                }
              },
            });
            const input = handle.createReadStream({ autoClose: false });
            if (temporary === undefined) {
              await NodeStreamPromises.pipeline(
                input,
                hasher,
                new NodeStream.Transform({
                  transform(_chunk, _encoding, callback) {
                    callback();
                  },
                }),
              );
            } else {
              await NodeStreamPromises.pipeline(
                input,
                hasher,
                NodeZlib.createGzip(),
                NodeFS.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
              );
            }
            if (version(await handle.stat()) !== version(before) || readBytes !== before.size) {
              refuse("a file changed during capture");
            }
          } finally {
            await handle.close();
          }
          const digest = hash.digest("hex");
          if (objects !== undefined && temporary === undefined && gitPayload?.hash !== digest)
            refuse("a Git-backed file changed during capture");
          if (temporary !== undefined) {
            await durable.add(async () => {
              await syncFile(temporary);
              const payload = NodePath.join(objects!, `${digest}.gz`);
              if (await exists(payload)) await NodeFSP.unlink(temporary);
              else await NodeFSP.rename(temporary, payload);
            });
          }
          entries[entryIndex] = {
            path: relative,
            kind: "file",
            mode: before.mode & 0o777,
            size: before.size,
            hash: digest,
          };
          if (version(await NodeFSP.lstat(absolute)) !== version(before))
            refuse("the workspace changed during capture");
        });
      } else refuse("special files are unsupported");
      if (version(await NodeFSP.lstat(absolute)) !== version(before))
        refuse("the workspace changed during capture");
    }
  };
  let attributes: ReadonlyArray<SuspensionAttribute> = [];
  let hiddenPaths: ReadonlyArray<string> = [];
  try {
    await inspect(root, "");
    for (const group of linkGroups.values())
      if (group.paths.length !== group.count)
        refuse("hardlinked files extend outside the workspace");
    const metadata = await metadataCheck(
      root,
      entries,
      true,
      selected === undefined ? limits : undefined,
    );
    attributes = metadata.attributes;
    hiddenPaths = metadata.hiddenPaths;
    const metadataBytes =
      hardlinks.reduce(
        (sum, item) => sum + Buffer.byteLength(item.path) + Buffer.byteLength(item.target),
        0,
      ) +
      hiddenPaths.reduce((sum, name) => sum + Buffer.byteLength(name), 0) +
      attributes.reduce(
        (sum, item) =>
          sum + item.hex.length / 2 + Buffer.byteLength(item.path) + Buffer.byteLength(item.name),
        0,
      );
    if (metadataBytes > Math.min(MAX_METADATA_BYTES, limits.maxBytes))
      refuse("workspace metadata exceeds the byte limit");
    rawBytes += metadataBytes;
    if (rawBytes > limits.maxBytes) refuse("the workspace exceeds the byte limit");
    for (const captureFile of files) await captureFile();
    const afterMetadata = await metadataCheck(
      root,
      entries,
      true,
      selected === undefined ? limits : undefined,
    );
    if (JSON.stringify(attributes) !== JSON.stringify(afterMetadata.attributes))
      refuse("extended attributes changed during capture");
    if (JSON.stringify(hiddenPaths) !== JSON.stringify(afterMetadata.hiddenPaths))
      refuse("filesystem flags changed during capture");
    for (const [absolute, stamp] of versions)
      if (version(await NodeFSP.lstat(absolute)) !== stamp)
        refuse("the workspace changed during capture");
  } finally {
    await durable.drain();
  }
  if (objects !== undefined) await syncDirectory(objects);
  return {
    ...(attributes.length === 0 ? {} : { attributes }),
    ...(hiddenPaths.length === 0 ? {} : { hiddenPaths }),
    ...(hardlinks.length === 0 ? {} : { hardlinks }),
    entries,
    rawBytes,
    rootMode: rootStat.mode & 0o777,
    rootIdentity: identity(rootStat),
    versions,
  };
};

// Extended index entries carry skip-worktree/intent-to-add state that write-tree loses.
const checkIndex = (data: Buffer, objectHashBytes: number) => {
  if (data.toString("ascii", 0, 4) !== "DIRC") refuse("the Git index is unsupported");
  const format = data.readUInt32BE(4);
  if (format !== 2 && format !== 3) refuse("this Git index format is unsupported");
  const count = data.readUInt32BE(8);
  let cursor = 12;
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const flagsAt = cursor + 40 + objectHashBytes;
    if (flagsAt + 2 > data.length) refuse("the Git index is incomplete");
    const flags = data.readUInt16BE(flagsAt);
    if ((flags & 0xf000) !== 0) refuse("conflicted or extended Git index entries are unsupported");
    cursor = data.indexOf(0, flagsAt + 2);
    if (cursor < 0) refuse("the Git index is incomplete");
    cursor = start + Math.ceil((cursor + 1 - start) / 8) * 8;
  }
  while (cursor < data.length - objectHashBytes) {
    if (cursor + 8 > data.length - objectHashBytes) refuse("the Git index is incomplete");
    const extension = data.toString("ascii", cursor, cursor + 4);
    if (extension !== "TREE") refuse("the Git index has unsupported extensions");
    cursor += 8 + data.readUInt32BE(cursor + 4);
  }
  if (cursor !== data.length - objectHashBytes) refuse("the Git index is incomplete");
  const expected = NodeCrypto.createHash(objectHashBytes === 20 ? "sha1" : "sha256")
    .update(data.subarray(0, cursor))
    .digest();
  if (!expected.equals(data.subarray(cursor))) refuse("the Git index checksum is invalid");
};

const assertEmptyGitlinks = async (root: string, indexEntries: Buffer) => {
  for (const entry of indexEntries.toString("utf8").split("\0")) {
    if (entry.startsWith("040000 ")) refuse("sparse index entries are unsupported");
    if (!entry.startsWith("160000 ")) continue;
    const name = entry.slice(entry.indexOf("\t") + 1);
    validRelativePath(name);
    const target = NodePath.join(root, name);
    if (await exists(target)) {
      const stat = await NodeFSP.lstat(target);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await NodeFSP.readdir(target)).length !== 0
      )
        refuse("populated submodule paths are unsupported");
    }
  }
};

const inspectPrivateGitDirectory = async (gitDirectory: string) => {
  const supported = new Set([
    "HEAD",
    "index",
    "gitdir",
    "commondir",
    "logs",
    "ORIG_HEAD",
    "FETCH_HEAD",
    "COMMIT_EDITMSG",
    "AUTO_MERGE",
    "MERGE_RR",
    "t3-dependency-activity.json",
    "refs",
  ]);
  for (const name of await NodeFSP.readdir(gitDirectory)) {
    if (!supported.has(name) && !/^t3-build-[a-f0-9]{64}\.json$/u.test(name))
      refuse("the worktree has unsupported private Git metadata");
    const stat = await NodeFSP.lstat(NodePath.join(gitDirectory, name));
    if (
      stat.isSymbolicLink() ||
      (["logs", "refs"].includes(name) ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    )
      refuse("the worktree private Git metadata is redirected");
    if (name === "refs" && (await NodeFSP.readdir(NodePath.join(gitDirectory, name))).length !== 0)
      refuse("worktree-local Git refs are unsupported");
  }
  if (await exists(NodePath.join(gitDirectory, "logs"))) {
    const names = await NodeFSP.readdir(NodePath.join(gitDirectory, "logs"));
    if (names.some((name) => name !== "HEAD"))
      refuse("the worktree has unsupported private Git logs");
    if (names.includes("HEAD")) {
      const stat = await NodeFSP.lstat(NodePath.join(gitDirectory, "logs", "HEAD"));
      if (!stat.isFile() || stat.nlink !== 1) refuse("the worktree private Git log is redirected");
    }
  }
};

const gitIdentity = async (source: string, purpose: "capture" | "activity" = "capture") => {
  await noLinkedAncestors(source);
  const dotGit = await NodeFSP.lstat(NodePath.join(source, ".git"));
  if (!dotGit.isFile() || dotGit.nlink !== 1) refuse("only linked Git worktrees are supported");
  const root = await gitText(source, ["rev-parse", "--show-toplevel"]);
  if (root !== source) refuse("the Git root does not match the workspace");
  const gitDirectory = await NodeFSP.realpath(
    await gitText(source, ["rev-parse", "--absolute-git-dir"]),
  );
  const commonDirectory = await NodeFSP.realpath(
    await gitText(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  if (gitDirectory === commonDirectory) refuse("the main checkout cannot be suspended");
  await noLinkedAncestors(gitDirectory);
  await noLinkedAncestors(commonDirectory);
  await noLinkedAncestors(NodePath.join(commonDirectory, "objects"));
  for (const name of ["HEAD", "gitdir", "commondir"]) {
    const stat = await NodeFSP.lstat(NodePath.join(gitDirectory, name));
    if (!stat.isFile() || stat.nlink !== 1)
      refuse("the worktree private Git metadata is redirected");
  }
  const registration = await NodeFSP.readFile(NodePath.join(gitDirectory, "gitdir"), "utf8");
  if (registration.trim() !== NodePath.join(source, ".git"))
    refuse("the Git worktree registration does not match");
  // Ordinary workspace use needs identity and a usage clock, even during an uncapturable Git operation.
  if (purpose === "capture") {
    if (await exists(NodePath.join(commonDirectory, "objects", "info", "alternates")))
      refuse("alternate Git object stores are unsupported");
    if ((await gitText(source, ["rev-parse", "--show-ref-format"])) !== "files")
      refuse("this Git ref storage format is unsupported");
    if ((await gitText(source, ["rev-parse", "--is-shallow-repository"])) !== "false")
      refuse("shallow Git repositories are unsupported");
    const configuration = (await git(source, ["config", "--null", "--list"]))
      .toString("utf8")
      .split("\0");
    if (
      configuration.some(
        (entry) =>
          /^(extensions\.partialclone|remote\..*\.promisor)\n/u.test(entry) &&
          !entry.endsWith("\nfalse"),
      )
    )
      refuse("partial Git repositories are unsupported");
    await inspectPrivateGitDirectory(gitDirectory);
    for (const marker of [
      "locked",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "BISECT_LOG",
      "index.lock",
      "config.worktree",
    ]) {
      if (await exists(NodePath.join(gitDirectory, marker)))
        refuse("the worktree has locked, in-progress, or unsupported Git state");
    }
  }
  const head = await gitText(source, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const symbolic = await NodeFSP.readFile(NodePath.join(gitDirectory, "HEAD"), "utf8");
  const branch = symbolic.startsWith("ref: refs/heads/") ? symbolic.slice(5).trim() : null;
  return {
    gitDirectory,
    gitDirectoryIdentity: identity(await NodeFSP.lstat(gitDirectory)),
    commonDirectory,
    commonIdentity: identity(await NodeFSP.stat(commonDirectory)),
    head,
    branch,
  };
};

const assertSnapshot = (value: unknown, id: string): WorktreeSuspensionSnapshot => {
  if (typeof value !== "object" || value === null)
    return refuse("the snapshot manifest is invalid");
  const snapshot = value as WorktreeSuspensionSnapshot;
  if (
    (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3) ||
    (snapshot.version !== 3 && snapshot.hardlinks !== undefined) ||
    (snapshot.version === 1 &&
      (snapshot.attributes !== undefined || snapshot.hiddenPaths !== undefined)) ||
    snapshot.id !== id ||
    !Array.isArray(snapshot.entries)
  )
    refuse("the snapshot format is unsupported");
  if (!Array.isArray(snapshot.gitFiles) || !Array.isArray(snapshot.gitRefs))
    refuse("the private Git snapshot is invalid");
  for (const entry of [...snapshot.entries, ...snapshot.gitFiles]) {
    validRelativePath(entry.path);
    if (
      !["directory", "file", "symlink"].includes(entry.kind) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      refuse("the snapshot manifest is invalid");
    if (
      entry.kind === "file" &&
      (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0)
    )
      refuse("the snapshot payload reference is invalid");
    if (entry.kind === "symlink" && typeof entry.target !== "string")
      refuse("the snapshot symlink is invalid");
  }
  if (snapshot.attributes !== undefined) {
    if (!Array.isArray(snapshot.attributes) || snapshot.attributes.length > MAX_ATTRIBUTES)
      refuse("the saved extended attributes exceed the record limit");
    const paths = new Set(["", ...snapshot.entries.map((entry) => entry.path)]);
    const keys = new Set<string>();
    let bytes = 0;
    for (const item of snapshot.attributes) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        !paths.has(item.path) ||
        !supportedAttribute(item.name) ||
        typeof item.hex !== "string" ||
        !/^(?:[a-f0-9]{2})*$/u.test(item.hex) ||
        item.hex.length > MAX_ATTRIBUTE_BYTES * 2
      )
        refuse("the saved extended attributes are invalid");
      const key = JSON.stringify([item.path, item.name]);
      if (keys.has(key)) refuse("the saved extended attributes are duplicated");
      keys.add(key);
      bytes += item.hex.length / 2 + Buffer.byteLength(item.path) + Buffer.byteLength(item.name);
      if (bytes > MAX_METADATA_BYTES) refuse("the saved extended attributes exceed the byte limit");
    }
  }
  if (snapshot.hiddenPaths !== undefined) {
    const paths = new Set(["", ...snapshot.entries.map((entry) => entry.path)]);
    if (
      !Array.isArray(snapshot.hiddenPaths) ||
      snapshot.hiddenPaths.length > paths.size ||
      new Set(snapshot.hiddenPaths).size !== snapshot.hiddenPaths.length ||
      snapshot.hiddenPaths.some((name) => typeof name !== "string" || !paths.has(name)) ||
      snapshot.hiddenPaths.reduce((sum, name) => sum + Buffer.byteLength(name), 0) +
        (snapshot.attributes ?? []).reduce(
          (sum, item) =>
            sum + item.hex.length / 2 + Buffer.byteLength(item.path) + Buffer.byteLength(item.name),
          0,
        ) >
        MAX_METADATA_BYTES
    )
      refuse("the saved filesystem flags are invalid");
  }
  if (snapshot.version === 3) {
    if (!Array.isArray(snapshot.hardlinks) || snapshot.hardlinks.length > snapshot.entries.length)
      refuse("the saved hardlinks are invalid");
    const entries = new Map(snapshot.entries.map((entry, index) => [entry.path, { entry, index }]));
    const aliases = new Set<string>();
    let bytes = 0;
    for (const link of snapshot.hardlinks) {
      if (
        link === null ||
        typeof link !== "object" ||
        typeof link.path !== "string" ||
        typeof link.target !== "string"
      )
        refuse("the saved hardlinks are invalid");
      const alias = entries.get(link.path);
      const target = entries.get(link.target);
      if (
        alias === undefined ||
        target === undefined ||
        alias.index <= target.index ||
        alias.entry.kind !== "file" ||
        target.entry.kind !== "file" ||
        alias.entry.hash !== target.entry.hash ||
        alias.entry.size !== target.entry.size ||
        alias.entry.mode !== target.entry.mode ||
        aliases.has(link.path)
      )
        refuse("the saved hardlinks are invalid");
      aliases.add(link.path);
      bytes += Buffer.byteLength(link.path) + Buffer.byteLength(link.target);
    }
    if (snapshot.hardlinks.some((link) => aliases.has(link.target)))
      refuse("the saved hardlinks are chained");
    bytes +=
      (snapshot.hiddenPaths ?? []).reduce((sum, name) => sum + Buffer.byteLength(name), 0) +
      (snapshot.attributes ?? []).reduce(
        (sum, item) =>
          sum + item.hex.length / 2 + Buffer.byteLength(item.path) + Buffer.byteLength(item.name),
        0,
      );
    if (bytes > MAX_METADATA_BYTES) refuse("the saved hardlinks exceed the metadata byte limit");
  }
  if (
    snapshot.headRef !== `refs/lastcode/suspension/${id}/head` ||
    snapshot.indexRef !== `refs/lastcode/suspension/${id}/index`
  )
    refuse("the snapshot refs are invalid");
  if (!/^[a-f0-9]{40,64}$/.test(snapshot.head) || !/^[a-f0-9]{40,64}$/.test(snapshot.indexTree))
    refuse("the snapshot Git identity is invalid");
  for (const [index, ref] of snapshot.gitRefs.entries()) {
    if (
      ref.ref !== `refs/lastcode/suspension/${id}/metadata/${index}` ||
      !/^[a-f0-9]{40,64}$/u.test(ref.object) ||
      (ref.type !== "commit" &&
        ref.type !== "tag" &&
        !(
          ref.type === "tree" &&
          ref.source === "AUTO_MERGE" &&
          snapshot.gitFiles.some(
            (entry) =>
              entry.path === "AUTO_MERGE" &&
              entry.kind === "file" &&
              [ref.object, `${ref.object}\n`].some(
                (contents) =>
                  entry.size === contents.length &&
                  entry.hash === NodeCrypto.createHash("sha256").update(contents).digest("hex"),
              ),
          )
        ))
    )
      refuse("the private Git recovery reference is invalid");
  }
  return snapshot;
};

export const createWorktreeSuspensionStore = (options: WorktreeSuspensionStoreOptions) => {
  const storeRoot = NodePath.resolve(options.storeRoot);
  const limits: WorktreeSuspensionLimits = {
    ...DEFAULT_WORKTREE_SUSPENSION_LIMITS,
    ...options.limits,
  };
  const gitFileNames = new Set([
    "ORIG_HEAD",
    "FETCH_HEAD",
    "COMMIT_EDITMSG",
    "AUTO_MERGE",
    "MERGE_RR",
    "t3-dependency-activity.json",
    "logs",
    "logs/HEAD",
    "refs",
  ]);
  const supportedGitFile = (name: string) =>
    gitFileNames.has(name) || /^t3-build-[a-f0-9]{64}\.json$/u.test(name);
  const metadataSelection = async (gitDirectory: string) =>
    new Set([...gitFileNames, ...(await NodeFSP.readdir(gitDirectory)).filter(supportedGitFile)]);
  const gitLimits = {
    ...limits,
    maxEntries: 256,
    maxFileBytes: Math.min(limits.maxFileBytes, 1024 * 1024),
    maxBytes: Math.min(limits.maxBytes, 8 * 1024 * 1024),
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 0) refuse("invalid preservation limits");
  const snapshotDirectory = (id: string) => NodePath.join(storeRoot, validId(id));
  const initialize = async () => {
    await privateDirectory(storeRoot);
  };
  const snapshotPath = (id: string) => NodePath.join(snapshotDirectory(id), "manifest.json");
  const journalPath = (id: string) => NodePath.join(snapshotDirectory(id), "journal.json");
  const objectsPath = (id: string) => NodePath.join(snapshotDirectory(id), "objects");
  const readJournal = async (id: string): Promise<WorktreeSuspensionJournal> => {
    await initialize();
    await privateDirectory(snapshotDirectory(id));
    const file = await NodeFSP.open(
      journalPath(id),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 1024 * 1024
      )
        refuse("the operation journal is not private and valid");
      const journal = JSON.parse(await file.readFile("utf8")) as WorktreeSuspensionJournal;
      if (
        journal.version !== 1 ||
        journal.snapshotId !== id ||
        typeof journal.operationId !== "string" ||
        ![
          "capturing",
          "capture-cleanup",
          "capture-cancelled",
          "verifying",
          "ready",
          "isolating",
          "isolated",
          "removing",
          "suspended",
          "restoring",
          "restored",
          "active",
          "discard-intent",
          "discarding",
          "discarded",
        ].includes(journal.phase)
      )
        refuse("the operation journal is invalid");
      return journal;
    } finally {
      await file.close();
    }
  };
  const transition = async (
    journal: WorktreeSuspensionJournal,
    phase: WorktreeSuspensionPhase,
    fields: Partial<WorktreeSuspensionJournal> = {},
  ) => {
    const next = { ...journal, ...fields, phase };
    await atomicJson(journalPath(journal.snapshotId), next);
    await options.onBoundary?.(phase, journal.snapshotId);
    return next;
  };
  const read = async (id: string) => {
    const journal = await readJournal(id);
    if (journal.phase === "discarding" || journal.phase === "discarded")
      refuse("the saved workspace was deliberately discarded");
    const file = await NodeFSP.open(
      snapshotPath(id),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 64 * 1024 * 1024
      )
        refuse("the snapshot manifest is invalid");
      const snapshot = assertSnapshot(JSON.parse(await file.readFile("utf8")), id);
      if (
        snapshot.operationId !== journal.operationId ||
        snapshot.entries.length > limits.maxEntries ||
        snapshot.rawBytes > limits.maxBytes
      )
        refuse("the snapshot operation does not match");
      return snapshot;
    } finally {
      await file.close();
    }
  };
  const freeSpace = async (directory: string, bytes: number, entries = 0) => {
    const stat = await NodeFSP.statfs(directory);
    if (stat.bavail * stat.bsize < bytes + entries * stat.bsize + limits.reserveBytes)
      refuse("insufficient space for verified preservation");
  };
  const validateRepository = async (snapshot: WorktreeSuspensionSnapshot) => {
    await noLinkedAncestors(snapshot.commonDirectory);
    if (
      !sameIdentity(identity(await NodeFSP.stat(snapshot.commonDirectory)), snapshot.commonIdentity)
    )
      refuse("the original Git repository is unavailable");
    const refs = new Map([
      [snapshot.headRef, snapshot.head],
      [snapshot.indexRef, snapshot.indexTree],
      ...snapshot.gitRefs.map((ref) => [ref.ref, ref.object] as const),
    ]);
    const actual = (
      await gitText(snapshot.commonDirectory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        `refs/lastcode/suspension/${snapshot.id}/`,
      ])
    ).split("\n");
    if (
      actual.length !== refs.size ||
      actual.some((line) => {
        const [name, object] = line.split(" ");
        return refs.get(name!) !== object;
      })
    )
      refuse("the recovery refs no longer match");
    return verifyGitObjects(snapshot, limits);
  };
  const verifyPayload = async (
    snapshot: WorktreeSuspensionSnapshot,
    entry: Extract<SuspensionEntry, { kind: "file" }>,
    output?: string,
    deferSync = false,
    gitPayloads?: ReadonlyMap<string, GitPayload>,
  ) => {
    const payload = NodePath.join(objectsPath(snapshot.id), `${entry.hash}.gz`);
    const file = await NodeFSP.open(
      payload,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    ).catch(async (error: NodeJS.ErrnoException) => {
      const gitPayload =
        error.code === "ENOENT" ? matchingGitPayload(entry, gitPayloads) : undefined;
      if (gitPayload === undefined) throw error;
      if (output !== undefined) {
        await NodeFSP.writeFile(output, gitPayload.bytes, { flag: "wx", mode: 0o600 });
        await NodeFSP.chmod(output, entry.mode);
        if (!deferSync) await syncFile(output);
      }
      return undefined;
    });
    if (file === undefined) return;
    let count = 0;
    const hash = NodeCrypto.createHash("sha256");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limits.maxFileBytes + 1024 * 1024)
        refuse("the saved payload is invalid");
      const meter = new NodeStream.Transform({
        transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          if (count > entry.size || count > limits.maxFileBytes)
            callback(new WorktreeSuspensionError("the saved payload exceeds its manifest"));
          else {
            hash.update(chunk);
            callback(null, chunk);
          }
        },
      });
      if (output === undefined) {
        await NodeStreamPromises.pipeline(
          file.createReadStream({ autoClose: false }),
          NodeZlib.createGunzip(),
          meter,
          new NodeStream.Transform({
            transform(_chunk, _encoding, callback) {
              callback();
            },
          }),
        );
      } else {
        await NodeStreamPromises.pipeline(
          file.createReadStream({ autoClose: false }),
          NodeZlib.createGunzip(),
          meter,
          NodeFS.createWriteStream(output, { flags: "wx", mode: 0o600 }),
        );
        await NodeFSP.chmod(output, entry.mode);
        if (!deferSync) await syncFile(output);
      }
      if (count !== entry.size || hash.digest("hex") !== entry.hash)
        refuse("the saved payload does not match its manifest");
    } finally {
      await file.close();
    }
  };
  const verify = async (id: string, input: { readonly durable?: boolean } = {}) => {
    const snapshot = await read(id);
    await privateDirectory(objectsPath(id));
    const gitObjects = await validateRepository(snapshot);
    if (input.durable) await syncGitObjects(snapshot.commonDirectory, gitObjects.objects, limits);
    for (const entry of snapshot.entries)
      if (entry.kind === "file")
        await verifyPayload(snapshot, entry, undefined, false, gitObjects.indexPayloads);
    for (const entry of snapshot.gitFiles)
      if (entry.kind === "file") await verifyPayload(snapshot, entry);
    return snapshot;
  };
  const compare = async (
    snapshot: WorktreeSuspensionSnapshot,
    root: string,
    requireSourceIdentity: boolean,
  ) => {
    const versions = new Map<string, string | null>();
    const saveVersion = async (file: string) =>
      versions.set(
        file,
        await NodeFSP.lstat(file).then(version, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      );
    for (const file of [
      NodePath.join(root, ".git"),
      snapshot.gitDirectory,
      ...["HEAD", "commondir", "gitdir", "index"].map((name) =>
        NodePath.join(snapshot.gitDirectory, name),
      ),
      NodePath.join(snapshot.commonDirectory, "packed-refs"),
      ...(snapshot.branch === null
        ? []
        : [NodePath.join(snapshot.commonDirectory, snapshot.branch)]),
      ...[snapshot.headRef, snapshot.indexRef, ...snapshot.gitRefs.map((ref) => ref.ref)].map(
        (ref) => NodePath.join(snapshot.commonDirectory, ref),
      ),
    ])
      await saveVersion(file);
    const current = await gitIdentity(root);
    if (
      current.commonDirectory !== snapshot.commonDirectory ||
      !sameIdentity(current.commonIdentity, snapshot.commonIdentity) ||
      current.head !== snapshot.head
    )
      refuse("the workspace Git identity changed");
    if (
      requireSourceIdentity &&
      (current.gitDirectory !== snapshot.gitDirectory ||
        !sameIdentity(current.gitDirectoryIdentity, snapshot.gitDirectoryIdentity) ||
        current.branch !== snapshot.branch ||
        !sameIdentity(identity(await NodeFSP.lstat(root)), snapshot.sourceIdentity))
    )
      refuse("the source workspace identity changed");
    const objectFormat = await gitText(root, ["rev-parse", "--show-object-format"]);
    const index = await NodeFSP.readFile(NodePath.join(current.gitDirectory, "index"));
    checkIndex(index, objectFormat === "sha1" ? 20 : 32);
    const temporary = NodePath.join(
      snapshotDirectory(snapshot.id),
      `index-${NodeCrypto.randomUUID()}`,
    );
    await NodeFSP.writeFile(temporary, index, { flag: "wx", mode: 0o600 });
    try {
      await assertEmptyGitlinks(
        root,
        await git(root, ["ls-files", "--stage", "-z"], { GIT_INDEX_FILE: temporary }),
      );
      if (
        (await gitText(root, ["write-tree"], { GIT_INDEX_FILE: temporary })) !== snapshot.indexTree
      )
        refuse("the staging area changed");
    } finally {
      await NodeFSP.unlink(temporary);
    }
    const currentInventory = await inventory(root, limits);
    const gitInventory = await inventory(
      current.gitDirectory,
      gitLimits,
      undefined,
      await metadataSelection(current.gitDirectory),
    );
    if (JSON.stringify(gitInventory.entries) !== JSON.stringify(snapshot.gitFiles))
      refuse("private Git metadata changed after capture");
    const rootStat = await NodeFSP.lstat(root);
    if (
      rootStat.uid !== snapshot.rootUid ||
      rootStat.gid !== snapshot.rootGid ||
      currentInventory.rootMode !== snapshot.rootMode ||
      JSON.stringify(currentInventory.hiddenPaths ?? []) !==
        JSON.stringify(snapshot.hiddenPaths ?? []) ||
      JSON.stringify(currentInventory.attributes ?? []) !==
        JSON.stringify(snapshot.attributes ?? []) ||
      JSON.stringify(currentInventory.entries) !== JSON.stringify(snapshot.entries) ||
      JSON.stringify(currentInventory.hardlinks ?? []) !== JSON.stringify(snapshot.hardlinks ?? [])
    )
      refuse("the workspace contents changed after capture");
    for (const [file, stamp] of [...currentInventory.versions, ...gitInventory.versions])
      if (!versions.has(file)) versions.set(file, stamp);
    return { snapshot, versions };
  };
  const syncRefs = async (snapshot: WorktreeSuspensionSnapshot) => {
    const directories = new Set<string>();
    for (const ref of [
      snapshot.headRef,
      snapshot.indexRef,
      ...snapshot.gitRefs.map((item) => item.ref),
    ]) {
      await syncFile(NodePath.join(snapshot.commonDirectory, ref));
      let directory = NodePath.dirname(NodePath.join(snapshot.commonDirectory, ref));
      while (within(snapshot.commonDirectory, directory)) {
        directories.add(directory);
        if (directory === snapshot.commonDirectory) break;
        directory = NodePath.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length))
      await syncDirectory(directory);
  };
  const captureMetadataRefs = async (gitDirectory: string, commonDirectory: string, id: string) => {
    const candidates = new Map<string, boolean>();
    for (const name of ["ORIG_HEAD", "FETCH_HEAD", "logs/HEAD"]) {
      const filename = NodePath.join(gitDirectory, name);
      if (!(await exists(filename))) continue;
      const contents = await NodeFSP.readFile(filename, "utf8");
      for (const line of contents.split("\n").filter(Boolean)) {
        const ids = name === "logs/HEAD" ? line.split(" ").slice(0, 2) : [line.split(/\s/u)[0]];
        for (const object of ids) {
          if (object === undefined || !/^[a-f0-9]{40,64}$/u.test(object))
            refuse("private Git commit metadata is unsupported");
          if (/^0+$/u.test(object!)) continue;
          candidates.set(object!, (candidates.get(object!) ?? false) || name === "ORIG_HEAD");
          if (candidates.size > 4096) refuse("private Git history exceeds preservation limits");
        }
      }
    }
    const autoMergePath = NodePath.join(gitDirectory, "AUTO_MERGE");
    let autoMergeTree: string | undefined;
    if (await exists(autoMergePath)) {
      const contents = await NodeFSP.readFile(autoMergePath, "utf8");
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/u.test(contents))
        refuse("private Git AUTO_MERGE metadata is unsupported");
      autoMergeTree = contents.trim();
      if (candidates.has(autoMergeTree)) refuse("private Git metadata object types disagree");
      candidates.set(autoMergeTree, true);
    }
    if (candidates.size === 0) return [];
    const responses = (
      await git(
        commonDirectory,
        ["cat-file", "--batch-check"],
        undefined,
        [...candidates.keys()].join("\n") + "\n",
      )
    )
      .toString("utf8")
      .trim()
      .split("\n");
    const refs: Array<WorktreeSuspensionSnapshot["gitRefs"][number]> = [];
    for (const line of responses) {
      const [object, type] = line.split(" ");
      if (!candidates.has(object!)) refuse("private Git objects could not be verified");
      if (type === "missing" && !candidates.get(object!)) continue;
      if (object === autoMergeTree ? type !== "tree" : type !== "commit" && type !== "tag")
        refuse("private Git recovery objects are missing or unsupported");
      refs.push({
        ref: `refs/lastcode/suspension/${id}/metadata/${refs.length}`,
        object: object!,
        ...(object === autoMergeTree
          ? { type: "tree", source: "AUTO_MERGE" }
          : { type: type as "commit" | "tag" }),
      });
    }
    return refs;
  };
  const capture = async (input: {
    readonly sourcePath: string;
    readonly snapshotId?: string;
    readonly operationId: string;
    readonly ownerBinding: string;
  }) => {
    await initialize();
    const sourcePath = NodePath.resolve(input.sourcePath);
    const id = validId(input.snapshotId ?? NodeCrypto.randomUUID());
    if (within(sourcePath, storeRoot) || within(storeRoot, sourcePath))
      refuse("the snapshot store overlaps the workspace");
    const repository = await gitIdentity(sourcePath);
    if (within(repository.commonDirectory, storeRoot))
      refuse("private payloads cannot be stored in Git metadata");
    const sourceStat = await NodeFSP.lstat(sourcePath);
    if (sourceStat.uid !== process.getuid?.() || (sourceStat.mode & 0o7000) !== 0)
      refuse("the workspace root has unsupported ownership or permissions");
    if (await exists(snapshotDirectory(id))) refuse("the snapshot identity already exists");
    await privateDirectory(snapshotDirectory(id));
    await privateDirectory(objectsPath(id));
    let journal: WorktreeSuspensionJournal = {
      version: 1,
      snapshotId: id,
      operationId: input.operationId,
      phase: "capturing",
      sourcePath,
      sourceIdentity: identity(sourceStat),
    };
    journal = await transition(journal, "capturing");
    const before = await inventory(sourcePath, limits);
    const metadataBefore = await inventory(
      repository.gitDirectory,
      gitLimits,
      undefined,
      await metadataSelection(repository.gitDirectory),
    );
    const allocationEntries = before.entries.length + metadataBefore.entries.length;
    const allocationBytes = before.rawBytes + metadataBefore.rawBytes;
    await freeSpace(storeRoot, allocationBytes * 2 + 64 * 1024 * 1024, allocationEntries * 2);
    await freeSpace(
      NodePath.dirname(sourcePath),
      allocationBytes + 64 * 1024 * 1024,
      allocationEntries,
    );
    const indexPath = NodePath.join(repository.gitDirectory, "index");
    const index = await NodeFSP.readFile(indexPath);
    const objectFormat = await gitText(sourcePath, ["rev-parse", "--show-object-format"]);
    checkIndex(index, objectFormat === "sha1" ? 20 : 32);
    const isolatedIndex = NodePath.join(snapshotDirectory(id), "capture-index");
    await NodeFSP.writeFile(isolatedIndex, index, { flag: "wx", mode: 0o600 });
    await assertEmptyGitlinks(
      sourcePath,
      await git(sourcePath, ["ls-files", "--stage", "-z"], { GIT_INDEX_FILE: isolatedIndex }),
    );
    const indexTree = await gitText(sourcePath, ["write-tree"], { GIT_INDEX_FILE: isolatedIndex });
    await NodeFSP.unlink(isolatedIndex);
    const gitPayloads = await verifyGitObjects(
      { ...repository, indexTree, gitRefs: [], entries: before.entries },
      limits,
    );
    const captured = await inventory(
      sourcePath,
      limits,
      objectsPath(id),
      undefined,
      gitPayloads.indexPayloads,
    );
    const metadata = await inventory(
      repository.gitDirectory,
      gitLimits,
      objectsPath(id),
      await metadataSelection(repository.gitDirectory),
    );
    if (
      JSON.stringify(before.entries) !== JSON.stringify(captured.entries) ||
      JSON.stringify(before.hardlinks ?? []) !== JSON.stringify(captured.hardlinks ?? []) ||
      before.rootMode !== captured.rootMode ||
      JSON.stringify(before.hiddenPaths ?? []) !== JSON.stringify(captured.hiddenPaths ?? []) ||
      JSON.stringify(before.attributes ?? []) !== JSON.stringify(captured.attributes ?? []) ||
      JSON.stringify(metadataBefore.entries) !== JSON.stringify(metadata.entries)
    )
      refuse("the workspace changed while preserving it");
    const headRef = `refs/lastcode/suspension/${id}/head`;
    const indexRef = `refs/lastcode/suspension/${id}/index`;
    const gitRefs = await captureMetadataRefs(
      repository.gitDirectory,
      repository.commonDirectory,
      id,
    );
    const objects = await NodeFSP.readdir(objectsPath(id));
    let savedBytes = 0;
    for (const object of objects)
      savedBytes += (await NodeFSP.stat(NodePath.join(objectsPath(id), object))).size;
    const snapshot: WorktreeSuspensionSnapshot = {
      version: captured.hardlinks === undefined ? 2 : 3,
      id,
      operationId: input.operationId,
      ownerBinding: input.ownerBinding,
      createdAt: new Date().toISOString(),
      sourcePath,
      sourceIdentity: identity(sourceStat),
      ...repository,
      headRef,
      indexRef,
      indexTree,
      ...(captured.attributes === undefined ? {} : { attributes: captured.attributes }),
      ...(captured.hiddenPaths === undefined ? {} : { hiddenPaths: captured.hiddenPaths }),
      ...(captured.hardlinks === undefined ? {} : { hardlinks: captured.hardlinks }),
      rootMode: captured.rootMode,
      rootUid: sourceStat.uid,
      rootGid: sourceStat.gid,
      entries: captured.entries,
      rawBytes: captured.rawBytes + metadata.rawBytes,
      savedBytes:
        savedBytes +
        (captured.hardlinks === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(captured.hardlinks))) +
        (captured.hiddenPaths === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(captured.hiddenPaths))) +
        (captured.attributes === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(captured.attributes))),
      gitFiles: metadata.entries,
      gitRefs,
    };
    journal = await transition(journal, "capturing", {
      captureRefs: {
        commonDirectory: snapshot.commonDirectory,
        commonIdentity: snapshot.commonIdentity,
        headRef,
        head: snapshot.head,
        indexRef,
        indexTree,
        gitRefs,
      },
    });
    await git(repository.commonDirectory, ["update-ref", headRef, repository.head, ""]);
    await git(repository.commonDirectory, ["update-ref", indexRef, indexTree, ""]);
    if (gitRefs.length > 0)
      await git(
        repository.commonDirectory,
        ["update-ref", "--stdin"],
        undefined,
        gitRefs.map((ref) => `create ${ref.ref} ${ref.object}\n`).join(""),
      );
    await syncRefs(snapshot);
    await atomicJson(snapshotPath(id), snapshot);
    journal = await transition(journal, "verifying");
    await verify(id, { durable: true });
    await compare(snapshot, sourcePath, true);
    return snapshot;
  };
  const materializeGitFiles = async (
    snapshot: WorktreeSuspensionSnapshot,
    gitDirectory: string,
    durable = true,
  ) => {
    for (const name of new Set([
      "ORIG_HEAD",
      "FETCH_HEAD",
      "COMMIT_EDITMSG",
      "AUTO_MERGE",
      "MERGE_RR",
      "t3-dependency-activity.json",
      "logs/HEAD",
      ...snapshot.gitFiles.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    ])) {
      const filename = NodePath.join(gitDirectory, name);
      if (await exists(filename)) {
        const stat = await NodeFSP.lstat(filename);
        if (!stat.isFile() || stat.nlink !== 1)
          refuse("private Git restore metadata is redirected");
        await NodeFSP.unlink(filename);
      }
    }
    for (const name of ["logs", "refs"]) {
      const directory = NodePath.join(gitDirectory, name);
      if (await exists(directory)) await NodeFSP.rmdir(directory);
    }
    for (const entry of snapshot.gitFiles) {
      if (!supportedGitFile(entry.path) || entry.kind === "symlink")
        refuse("the private Git restore manifest is invalid");
      const target = NodePath.join(gitDirectory, entry.path);
      if (entry.kind === "directory") await NodeFSP.mkdir(target, { mode: 0o700 });
      else if (entry.kind === "file") await verifyPayload(snapshot, entry, target, !durable);
    }
    for (let offset = snapshot.gitFiles.length - 1; offset >= 0; offset -= 1) {
      const entry = snapshot.gitFiles[offset]!;
      if (entry.kind !== "directory") continue;
      await NodeFSP.chmod(NodePath.join(gitDirectory, entry.path), entry.mode);
      if (durable) await syncDirectory(NodePath.join(gitDirectory, entry.path));
    }
    if (durable) await syncDirectory(gitDirectory);
  };
  const savedPrefix = async (
    snapshot: WorktreeSuspensionSnapshot,
    entry: Extract<SuspensionEntry, { kind: "file" }>,
    filename: string,
    current: Extract<SuspensionEntry, { kind: "file" }>,
    gitPayloads: ReadonlyMap<string, GitPayload>,
  ) => {
    if (current.size > entry.size) refuse("the partial restore contains unknown file contents");
    const file = await NodeFSP.open(
      filename,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    const before = await file.stat();
    const hash = NodeCrypto.createHash("sha256");
    let count = 0;
    try {
      const payload = NodePath.join(objectsPath(snapshot.id), `${entry.hash}.gz`);
      const gitPayload = !(await exists(payload))
        ? matchingGitPayload(entry, gitPayloads)
        : undefined;
      const comparePrefix = new NodeStream.Writable({
        write(chunk: Buffer, _encoding, callback) {
          const length = Math.min(chunk.length, current.size - count);
          if (length <= 0) {
            callback();
            return;
          }
          const actual = Buffer.alloc(length);
          file.read(actual, 0, length, count).then(({ bytesRead }) => {
            if (bytesRead !== length || !actual.equals(chunk.subarray(0, length))) {
              callback(
                new WorktreeSuspensionError("the partial restore contains unknown file contents"),
              );
            } else {
              hash.update(actual);
              count += length;
              callback();
            }
          }, callback);
        },
      });
      if (gitPayload === undefined)
        await NodeStreamPromises.pipeline(
          NodeFS.createReadStream(payload),
          NodeZlib.createGunzip(),
          comparePrefix,
        );
      else
        await NodeStreamPromises.pipeline(
          NodeStream.Readable.from([gitPayload.bytes]),
          comparePrefix,
        );
      if (
        count !== current.size ||
        hash.digest("hex") !== current.hash ||
        version(before) !== version(await file.stat()) ||
        version(before) !== version(await NodeFSP.lstat(filename))
      )
        refuse("the partial restore changed during recovery");
    } finally {
      await file.close();
    }
  };
  const populate = async (
    snapshot: WorktreeSuspensionSnapshot,
    destination: string,
    resume: boolean,
    durableRestore = true,
  ) => {
    const { indexPayloads } = await validateRepository(snapshot);
    const present = resume ? await inventory(destination, limits) : undefined;
    if (
      present?.attributes !== undefined &&
      present.attributes.some(
        (item) =>
          !snapshot.attributes?.some((saved) => JSON.stringify(saved) === JSON.stringify(item)),
      )
    )
      refuse("the partial restore contains unknown extended attributes");
    const savedHiddenPaths = new Set(snapshot.hiddenPaths);
    if (present?.hiddenPaths?.some((name) => !savedHiddenPaths.has(name)))
      refuse("the partial restore contains unknown filesystem flags");
    const actual = new Map(present?.entries.map((entry) => [entry.path, entry]));
    const expected = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    const hardlinks = new Map(snapshot.hardlinks?.map((link) => [link.path, link.target]));
    for (const link of present?.hardlinks ?? [])
      if ((hardlinks.get(link.path) ?? link.path) !== (hardlinks.get(link.target) ?? link.target))
        refuse("the partial restore contains unknown hardlinked files");
    for (const entry of actual.values()) {
      const saved = expected.get(entry.path);
      if (saved === undefined || saved.kind !== entry.kind)
        refuse("the partial restore contains unknown paths");
      if (
        entry.kind === "symlink" &&
        saved.kind === "symlink" &&
        (entry.target !== saved.target || entry.mode !== saved.mode)
      )
        refuse("the partial restore contains an unknown symlink");
      if (entry.kind === "directory" && entry.mode !== saved.mode && entry.mode !== 0o700)
        refuse("the partial restore has unknown directory permissions");
      if (entry.kind === "file" && saved.kind === "file") {
        if (entry.mode !== saved.mode && entry.mode !== 0o600)
          refuse("the partial restore has unknown file permissions");
        if (entry.hash !== saved.hash || entry.size !== saved.size)
          await savedPrefix(
            snapshot,
            saved,
            NodePath.join(destination, entry.path),
            entry,
            indexPayloads,
          );
      }
    }
    const gitDirectory = (await gitIdentity(destination)).gitDirectory;
    const indexPath = NodePath.join(gitDirectory, "index");
    if (resume && (await exists(indexPath))) {
      const index = await NodeFSP.readFile(indexPath);
      checkIndex(index, snapshot.head.length === 40 ? 20 : 32);
      const temporary = NodePath.join(
        snapshotDirectory(snapshot.id),
        `index-${NodeCrypto.randomUUID()}`,
      );
      await NodeFSP.writeFile(temporary, index, { flag: "wx", mode: 0o600 });
      try {
        if (
          (await gitText(destination, ["write-tree"], { GIT_INDEX_FILE: temporary })) !==
          snapshot.indexTree
        )
          refuse("the partial restore staging area changed");
      } finally {
        await NodeFSP.unlink(temporary);
      }
    }
    await git(destination, ["read-tree", snapshot.indexTree]);
    await NodeFSP.chown(destination, snapshot.rootUid, snapshot.rootGid);
    const durable = durabilityBatch();
    try {
      for (const entry of snapshot.entries) {
        const absolute = NodePath.join(destination, entry.path);
        const existing = actual.get(entry.path);
        if (entry.kind === "directory") {
          if (existing === undefined) await NodeFSP.mkdir(absolute, { mode: 0o700 });
          else await NodeFSP.chmod(absolute, 0o700);
        } else if (entry.kind === "symlink") {
          if (existing === undefined) await NodeFSP.symlink(entry.target, absolute);
        } else if (hardlinks.has(entry.path)) {
          const target = NodePath.join(destination, hardlinks.get(entry.path)!);
          let linked = false;
          if (existing !== undefined) {
            const [aliasStat, targetStat] = await Promise.all([
              NodeFSP.lstat(absolute),
              NodeFSP.lstat(target),
            ]);
            linked = sameIdentity(identity(aliasStat), identity(targetStat));
            if (!linked) await NodeFSP.unlink(absolute);
          }
          if (!linked) await NodeFSP.link(target, absolute);
        } else if (
          existing?.kind !== "file" ||
          existing.hash !== entry.hash ||
          existing.size !== entry.size
        ) {
          if (existing !== undefined) await NodeFSP.unlink(absolute);
          await verifyPayload(snapshot, entry, absolute, true, indexPayloads);
        }
        if (entry.kind === "symlink")
          await NodeFSP.lchown(absolute, snapshot.rootUid, snapshot.rootGid);
        else {
          await NodeFSP.chown(absolute, snapshot.rootUid, snapshot.rootGid);
          await NodeFSP.chmod(absolute, entry.kind === "directory" ? 0o700 : entry.mode);
        }
        if (durableRestore && entry.kind === "file") await durable.add(() => syncFile(absolute));
      }
    } finally {
      await durable.drain();
    }
    for (const item of snapshot.attributes ?? []) {
      if (HostProcess.Platform.defaultValue() !== "darwin")
        refuse("saved extended attributes require macOS");
      const absolute = NodePath.join(destination, item.path);
      await command("/usr/bin/xattr", ["-swx", item.name, item.hex, absolute]);
      const entry = expected.get(item.path);
      if (durableRestore && entry?.kind !== "symlink") await syncFile(absolute);
    }
    for (const name of snapshot.hiddenPaths ?? []) {
      if (HostProcess.Platform.defaultValue() !== "darwin")
        refuse("saved filesystem flags require macOS");
      const absolute = NodePath.join(destination, name);
      await command("/usr/bin/chflags", ["-h", "hidden", absolute]);
      if (durableRestore && expected.get(name)?.kind !== "symlink") await syncFile(absolute);
    }
    for (let offset = snapshot.entries.length - 1; offset >= 0; offset -= 1) {
      const entry = snapshot.entries[offset]!;
      if (entry.kind === "directory") {
        await NodeFSP.chmod(NodePath.join(destination, entry.path), entry.mode);
        if (durableRestore) await syncDirectory(NodePath.join(destination, entry.path));
      }
    }
    await NodeFSP.chmod(destination, snapshot.rootMode);
    await materializeGitFiles(snapshot, gitDirectory, durableRestore);
    if (durableRestore) {
      await syncFile(NodePath.join(gitDirectory, "index"));
      await syncFile(NodePath.join(gitDirectory, "HEAD"));
      await syncFile(NodePath.join(destination, ".git"));
      await syncDirectory(gitDirectory);
      await syncDirectory(NodePath.dirname(gitDirectory));
      await syncDirectory(snapshot.commonDirectory);
      await syncDirectory(destination);
      await syncDirectory(NodePath.dirname(destination));
    }
    await compare(snapshot, destination, false);
  };
  const materialize = async (
    snapshot: WorktreeSuspensionSnapshot,
    destination: string,
    onCreated?: (root: FileIdentity, gitDirectory: string) => Promise<void>,
    durableRestore = true,
  ) => {
    if (await exists(destination)) refuse("the restore destination is occupied");
    await noLinkedAncestors(NodePath.dirname(destination));
    await freeSpace(
      NodePath.dirname(destination),
      snapshot.rawBytes + 64 * 1024 * 1024,
      snapshot.entries.length + snapshot.gitFiles.length,
    );
    await git(snapshot.commonDirectory, [
      "worktree",
      "add",
      "--no-checkout",
      "--detach",
      "--",
      destination,
      snapshot.head,
    ]);
    if (durableRestore) {
      await syncFile(NodePath.join(destination, ".git"));
      await syncDirectory(destination);
      await syncDirectory(NodePath.dirname(destination));
    }
    const created = await gitIdentity(destination);
    await onCreated?.(identity(await NodeFSP.lstat(destination)), created.gitDirectory);
    await populate(snapshot, destination, false, durableRestore);
  };
  const trialRestore = async (id: string) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (journal.phase === "ready") return snapshot;
    if (
      journal.phase !== "verifying" &&
      !(journal.phase === "active" && journal.trialPath !== undefined)
    )
      refuse("the snapshot is not available for trial restoration");
    const finalPhase = journal.phase === "active" ? "active" : "ready";
    const original = await NodeFSP.lstat(snapshot.sourcePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    const durableTrial =
      original === undefined || !sameIdentity(identity(original), snapshot.sourceIdentity);
    const temporary =
      journal.trialPath ?? NodePath.join(snapshotDirectory(id), `trial-${NodeCrypto.randomUUID()}`);
    if (
      NodePath.dirname(temporary) !== snapshotDirectory(id) ||
      !/^trial-[a-f0-9-]{36}$/u.test(NodePath.basename(temporary))
    )
      refuse("the trial restore path is invalid");
    journal = await transition(journal, journal.phase, { trialPath: temporary });
    if (await exists(temporary)) {
      const current = await gitIdentity(temporary);
      if (
        current.commonDirectory !== snapshot.commonDirectory ||
        current.head !== snapshot.head ||
        current.branch !== null
      )
        refuse("the trial restore Git identity changed");
      if (
        journal.trialIdentity !== undefined &&
        (!sameIdentity(identity(await NodeFSP.lstat(temporary)), journal.trialIdentity) ||
          journal.trialGitDirectory !== current.gitDirectory)
      )
        refuse("the trial restore identity changed");
      journal = await transition(journal, journal.phase, {
        trialIdentity: identity(await NodeFSP.lstat(temporary)),
        trialGitDirectory: current.gitDirectory,
      });
      await populate(snapshot, temporary, true, durableTrial);
    } else
      await materialize(
        snapshot,
        temporary,
        async (trialIdentity, trialGitDirectory) => {
          journal = await transition(journal, journal.phase, { trialIdentity, trialGitDirectory });
        },
        durableTrial,
      );
    await compare(snapshot, temporary, false);
    if (!sameIdentity(identity(await NodeFSP.lstat(temporary)), journal.trialIdentity!))
      refuse("the trial restore was replaced");
    await git(snapshot.commonDirectory, ["worktree", "remove", "--force", "--", temporary]);
    await syncDirectory(snapshotDirectory(id));
    if (await exists(NodePath.dirname(journal.trialGitDirectory!)))
      await syncDirectory(NodePath.dirname(journal.trialGitDirectory!));
    await syncDirectory(snapshot.commonDirectory);
    const finished = { ...journal };
    delete finished.trialPath;
    delete finished.trialIdentity;
    delete finished.trialGitDirectory;
    await transition(finished, finalPhase);
    return snapshot;
  };
  const isolate = async (id: string, input: { readonly quarantineParent: string }) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (journal.phase !== "ready") refuse("the snapshot has not passed trial restoration");
    await compare(snapshot, snapshot.sourcePath, true);
    const quarantineParent = NodePath.resolve(input.quarantineParent);
    if (
      within(snapshot.sourcePath, quarantineParent) ||
      within(quarantineParent, snapshot.sourcePath)
    )
      refuse("the isolation path overlaps the workspace");
    await privateDirectory(quarantineParent);
    if ((await NodeFSP.stat(quarantineParent)).dev !== snapshot.sourceIdentity.dev)
      refuse("isolation requires the same filesystem");
    const isolatedPath = NodePath.join(quarantineParent, id);
    if (await exists(isolatedPath)) refuse("the isolation destination is occupied");
    journal = await transition(journal, "isolating", { isolatedPath });
    await git(snapshot.commonDirectory, [
      "worktree",
      "move",
      "--",
      snapshot.sourcePath,
      isolatedPath,
    ]);
    await syncFile(NodePath.join(isolatedPath, ".git"));
    await syncFile(NodePath.join(snapshot.gitDirectory, "gitdir"));
    await syncDirectory(snapshot.gitDirectory);
    if (await exists(NodePath.dirname(snapshot.gitDirectory)))
      await syncDirectory(NodePath.dirname(snapshot.gitDirectory));
    await syncDirectory(snapshot.commonDirectory);
    await syncDirectory(NodePath.dirname(snapshot.sourcePath));
    await syncDirectory(quarantineParent);
    return transition(journal, "isolated");
  };
  const verifyIsolated = async (id: string) => {
    const snapshot = await verify(id);
    const journal = await readJournal(id);
    if (journal.phase !== "isolated" || journal.isolatedPath === undefined)
      refuse("the operation has no verified isolated workspace");
    if (await exists(snapshot.sourcePath)) refuse("the original path became occupied");
    await compare(snapshot, journal.isolatedPath!, true);
    return snapshot;
  };
  const preparedRemovals = new Map<
    string,
    {
      snapshot: WorktreeSuspensionSnapshot;
      journal: WorktreeSuspensionJournal;
      versions: ReadonlyMap<string, string | null>;
    }
  >();
  const prepareRemoval = async (id: string) => {
    const snapshot = await verifyIsolated(id);
    let journal = await readJournal(id);
    if (journal.isolatedPath === undefined) refuse("the isolation identity is missing");
    const checked = await compare(snapshot, journal.isolatedPath!, true);
    journal = await transition(journal, "removing");
    preparedRemovals.set(id, { snapshot, journal, versions: checked.versions });
    return journal;
  };
  const finishRemoval = async (id: string) => {
    const prepared = preparedRemovals.get(id);
    if (prepared === undefined) refuse("removal needs fresh preparation in this process");
    const { snapshot, journal, versions } = prepared!;
    // The caller runs its final native/owner guard before this bounded scan. Keep
    // the scan and Git spawn in one turn so an application writer cannot interleave.
    for (const [file, expected] of versions) {
      let actual: string | null;
      try {
        actual = version(NodeFS.lstatSync(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        actual = null;
      }
      if (actual !== expected) refuse("the prepared workspace changed before removal");
    }
    if (
      NodeFS.existsSync(snapshot.sourcePath) ||
      !sameIdentity(identity(NodeFS.lstatSync(journal.isolatedPath!)), snapshot.sourceIdentity) ||
      !sameIdentity(
        identity(NodeFS.lstatSync(snapshot.gitDirectory)),
        snapshot.gitDirectoryIdentity,
      )
    )
      refuse("the isolated workspace was replaced");
    preparedRemovals.delete(id);
    await git(snapshot.commonDirectory, [
      "worktree",
      "remove",
      "--force",
      "--",
      journal.isolatedPath!,
    ]);
    if (await exists(journal.isolatedPath!))
      refuse("the isolated workspace was not completely removed");
    await syncDirectory(NodePath.dirname(journal.isolatedPath!));
    if (await exists(NodePath.dirname(snapshot.gitDirectory)))
      await syncDirectory(NodePath.dirname(snapshot.gitDirectory));
    await syncDirectory(snapshot.commonDirectory);
    return transition(journal, "suspended");
  };
  const removeIsolated = async (id: string) => {
    await prepareRemoval(id);
    return finishRemoval(id);
  };
  const rollbackIsolation = async (id: string) => {
    const snapshot = await read(id);
    const journal = await readJournal(id);
    if (!["isolating", "isolated"].includes(journal.phase) || journal.isolatedPath === undefined)
      refuse("this operation cannot safely roll back isolation");
    if (await exists(snapshot.sourcePath)) refuse("the original path is occupied");
    const moved = await gitIdentity(journal.isolatedPath!);
    if (
      moved.gitDirectory !== snapshot.gitDirectory ||
      !sameIdentity(moved.gitDirectoryIdentity, snapshot.gitDirectoryIdentity) ||
      !sameIdentity(identity(await NodeFSP.lstat(journal.isolatedPath!)), snapshot.sourceIdentity)
    )
      refuse("the isolation identity changed");
    await git(snapshot.commonDirectory, [
      "worktree",
      "move",
      "--",
      journal.isolatedPath!,
      snapshot.sourcePath,
    ]);
    await syncFile(NodePath.join(snapshot.gitDirectory, "gitdir"));
    await syncDirectory(NodePath.dirname(snapshot.sourcePath));
    await syncDirectory(NodePath.dirname(journal.isolatedPath!));
    return transition(journal, "ready");
  };
  const reconcileRemoval = async (id: string) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (
      !["isolating", "isolated", "removing"].includes(journal.phase) ||
      journal.isolatedPath === undefined
    )
      refuse("there is no interrupted isolation or removal");
    if (journal.phase === "removing" && preparedRemovals.has(id)) {
      // This process has not spent the preparation token or spawned removal.
      // Moving the same root back preserves even edits that vetoed the guard.
      preparedRemovals.delete(id);
      journal = await transition(journal, "isolated");
    }
    const sourcePresent = await exists(snapshot.sourcePath);
    const isolatedPresent = await exists(journal.isolatedPath!);
    if (sourcePresent && !isolatedPresent && journal.phase === "isolating") {
      const current = await gitIdentity(snapshot.sourcePath);
      if (
        current.gitDirectory !== snapshot.gitDirectory ||
        !sameIdentity(identity(await NodeFSP.lstat(snapshot.sourcePath)), snapshot.sourceIdentity)
      )
        refuse("the original recovery identity changed");
      journal = await transition(journal, "ready");
      return { status: "original-kept" as const, journal };
    }
    if (sourcePresent) refuse("the original recovery path is occupied");
    if (!isolatedPresent) {
      if (journal.phase !== "removing") refuse("the removal registration needs reconciliation");
      if (await exists(snapshot.gitDirectory)) {
        await noLinkedAncestors(snapshot.gitDirectory);
        if (
          !sameIdentity(
            identity(await NodeFSP.lstat(snapshot.gitDirectory)),
            snapshot.gitDirectoryIdentity,
          )
        )
          refuse("the original Git registration was replaced");
        await inspectPrivateGitDirectory(snapshot.gitDirectory);
        if (
          (
            await NodeFSP.readFile(NodePath.join(snapshot.gitDirectory, "gitdir"), "utf8")
          ).trim() !== NodePath.join(journal.isolatedPath!, ".git")
        )
          refuse("the missing workspace registration changed");
        const metadata = await inventory(
          snapshot.gitDirectory,
          gitLimits,
          undefined,
          await metadataSelection(snapshot.gitDirectory),
        );
        const expected = new Map(snapshot.gitFiles.map((entry) => [entry.path, entry]));
        if (
          metadata.entries.some(
            (entry) => JSON.stringify(expected.get(entry.path)) !== JSON.stringify(entry),
          )
        )
          refuse("the remaining Git metadata changed");
        const indexPath = NodePath.join(snapshot.gitDirectory, "index");
        if (await exists(indexPath)) {
          const index = await NodeFSP.readFile(indexPath);
          checkIndex(index, snapshot.head.length === 40 ? 20 : 32);
          const temporary = NodePath.join(
            snapshotDirectory(id),
            `index-${NodeCrypto.randomUUID()}`,
          );
          await NodeFSP.writeFile(temporary, index, { flag: "wx", mode: 0o600 });
          try {
            if (
              (await gitText(
                snapshot.commonDirectory,
                [
                  "--git-dir",
                  snapshot.gitDirectory,
                  "--work-tree",
                  journal.isolatedPath!,
                  "write-tree",
                ],
                { GIT_INDEX_FILE: temporary },
              )) !== snapshot.indexTree
            )
              refuse("the missing workspace staging area changed");
          } finally {
            await NodeFSP.unlink(temporary);
          }
        }
        if (await exists(journal.isolatedPath!)) refuse("the removed workspace became occupied");
        await git(snapshot.commonDirectory, [
          "worktree",
          "remove",
          "--force",
          "--",
          journal.isolatedPath!,
        ]);
      }
      await syncDirectory(NodePath.dirname(journal.isolatedPath!));
      await syncDirectory(snapshot.commonDirectory);
      journal = await transition(journal, "suspended");
      return { status: "suspended" as const, journal };
    }
    if (
      !sameIdentity(identity(await NodeFSP.lstat(journal.isolatedPath!)), snapshot.sourceIdentity)
    )
      refuse("the isolated recovery identity changed");
    if (journal.phase === "removing") {
      try {
        await compare(snapshot, journal.isolatedPath!, true);
      } catch {
        return { status: "restore-required" as const, journal };
      }
      journal = await transition(journal, "isolated");
    }
    journal = await rollbackIsolation(id);
    return { status: "original-kept" as const, journal };
  };
  const keepOriginal = async (id: string) => {
    const journal = await readJournal(id);
    if (
      !["capturing", "verifying", "ready"].includes(journal.phase) ||
      journal.sourcePath === undefined ||
      journal.sourceIdentity === undefined
    )
      refuse("the operation cannot keep an original workspace");
    await noLinkedAncestors(journal.sourcePath!);
    if (!sameIdentity(identity(await NodeFSP.lstat(journal.sourcePath!)), journal.sourceIdentity!))
      refuse("the original workspace identity changed");
    if (journal.isolatedPath !== undefined && (await exists(journal.isolatedPath)))
      refuse("the isolated recovery path is still occupied");
    return transition(journal, "active");
  };
  const suspend = async (
    id: string,
    input: {
      readonly quarantineParent: string;
      readonly guard: (input: {
        readonly sourcePath: string;
        readonly isolatedPath: string;
        readonly snapshot: WorktreeSuspensionSnapshot;
      }) => Promise<void>;
    },
  ) => {
    const journal = await isolate(id, input);
    try {
      const snapshot = await verifyIsolated(id);
      await prepareRemoval(id);
      await input.guard({
        sourcePath: snapshot.sourcePath,
        isolatedPath: journal.isolatedPath!,
        snapshot,
      });
      return await finishRemoval(id);
    } catch (error) {
      const current = await readJournal(id);
      if (current.phase === "isolated") await rollbackIsolation(id);
      else if (current.phase === "removing") await reconcileRemoval(id);
      throw error;
    }
  };
  const stageRestore = async (
    id: string,
    input: { readonly destinationPath: string; readonly branchName?: string },
  ) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (!["suspended", "active", "removing"].includes(journal.phase))
      refuse("the operation is not ready for restoration");
    const destinationPath = NodePath.resolve(input.destinationPath);
    if (within(storeRoot, destinationPath) || within(destinationPath, storeRoot))
      refuse("the restore destination overlaps the private store");
    await noLinkedAncestors(NodePath.dirname(destinationPath));
    if (await exists(destinationPath)) refuse("the restore destination is occupied");
    const container = NodePath.join(
      NodePath.dirname(destinationPath),
      `.suspension-restore-${id}-${NodeCrypto.randomUUID()}`,
    );
    const temporary = NodePath.join(container, "checkout");
    const requestedBranch =
      input.branchName === undefined
        ? snapshot.branch
        : input.branchName.startsWith("refs/heads/")
          ? input.branchName
          : `refs/heads/${input.branchName}`;
    const nextRestore = { ...journal };
    delete nextRestore.branch;
    delete nextRestore.restoreIdentity;
    delete nextRestore.restoreGitDirectory;
    delete nextRestore.restoreContainerIdentity;
    journal = await transition(nextRestore, "restoring", {
      restorePath: temporary,
      destinationPath,
      requestedBranch,
      requestedBranchExplicit: input.branchName !== undefined,
    });
    await privateDirectory(container);
    journal = await transition(journal, "restoring", {
      restoreContainerIdentity: identity(await NodeFSP.lstat(container)),
    });
    await materialize(snapshot, temporary, async (restoreIdentity, restoreGitDirectory) => {
      journal = await transition(journal, "restoring", { restoreIdentity, restoreGitDirectory });
    });
    return journal;
  };
  const restoreCandidate = async (
    snapshot: WorktreeSuspensionSnapshot,
    journal: WorktreeSuspensionJournal,
    candidate: string,
  ) => {
    if (
      journal.restoreIdentity === undefined ||
      journal.restoreGitDirectory === undefined ||
      !sameIdentity(identity(await NodeFSP.lstat(candidate)), journal.restoreIdentity)
    )
      refuse("the owned restore identity is missing or changed");
    const current = await gitIdentity(candidate);
    if (
      current.gitDirectory !== journal.restoreGitDirectory ||
      current.commonDirectory !== snapshot.commonDirectory ||
      current.head !== snapshot.head
    )
      refuse("the owned restore Git identity changed");
    return current;
  };
  const restoreContainer = (id: string, journal: WorktreeSuspensionJournal) => {
    if (
      journal.restorePath === undefined ||
      journal.destinationPath === undefined ||
      NodePath.basename(journal.restorePath) !== "checkout"
    )
      refuse("the restore paths are invalid");
    const container = NodePath.dirname(journal.restorePath!);
    if (
      NodePath.dirname(container) !== NodePath.dirname(journal.destinationPath!) ||
      !NodePath.basename(container).startsWith(`.suspension-restore-${id}-`)
    )
      refuse("the restore container is invalid");
    return container;
  };
  const publishRestore = async (id: string) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (
      journal.phase !== "restoring" ||
      journal.restorePath === undefined ||
      journal.destinationPath === undefined
    )
      refuse("the operation has no staged restore");
    const temporary = journal.restorePath!;
    const destinationPath = journal.destinationPath!;
    if (!(await exists(temporary)) && (await exists(destinationPath))) {
      const current = await restoreCandidate(snapshot, journal, destinationPath);
      await compare(snapshot, destinationPath, false);
      if (current.branch === null || current.branch !== journal.branch)
        refuse("the published restore branch does not match");
      const container = restoreContainer(id, journal);
      if (await exists(container)) {
        await privateDirectory(container);
        if (
          !sameIdentity(identity(await NodeFSP.lstat(container)), journal.restoreContainerIdentity!)
        )
          refuse("the restore container identity changed");
        await NodeFSP.rmdir(container);
        await syncDirectory(NodePath.dirname(destinationPath));
      }
      journal = await transition(journal, "restored");
      return { path: destinationPath, branch: current.branch, head: snapshot.head, journal };
    }
    if (await exists(destinationPath)) refuse("the restore destination became occupied");
    await restoreCandidate(snapshot, journal, temporary);
    await compare(snapshot, temporary, false);
    const requested = journal.requestedBranch ?? snapshot.branch;
    let branch = journal.branch;
    if (branch === undefined) {
      branch = `refs/heads/suspension/${id}-${NodeCrypto.randomUUID().slice(0, 8)}`;
      if (requested !== null) {
        await git(snapshot.commonDirectory, ["check-ref-format", requested]);
        const refs = await gitText(snapshot.commonDirectory, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          requested,
        ]);
        const worktrees = (
          await git(snapshot.commonDirectory, ["worktree", "list", "--porcelain", "-z"])
        )
          .toString("utf8")
          .split("\0");
        if (
          (refs === `${requested} ${snapshot.head}` ||
            (journal.requestedBranchExplicit === true && refs === "")) &&
          !worktrees.includes(`branch ${requested}`)
        )
          branch = requested;
      }
      journal = await transition(journal, "restoring", { branch });
    }
    const existing = await gitText(snapshot.commonDirectory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      branch!,
    ]);
    if (existing === "")
      await git(snapshot.commonDirectory, ["update-ref", branch!, snapshot.head, ""]);
    else if (existing !== `${branch} ${snapshot.head}`) refuse("the restore branch advanced");
    const current = await gitIdentity(temporary);
    const worktrees = (
      await git(snapshot.commonDirectory, ["worktree", "list", "--porcelain", "-z"])
    )
      .toString("utf8")
      .split("\0");
    if (current.branch !== branch && worktrees.includes(`branch ${branch}`))
      refuse("the restore branch was claimed");
    await git(temporary, ["symbolic-ref", "HEAD", branch!]);
    await materializeGitFiles(snapshot, current.gitDirectory);
    await syncFile(NodePath.join(current.gitDirectory, "HEAD"));
    await compare(snapshot, temporary, false);
    if (await exists(destinationPath)) refuse("the restore destination became occupied");
    await git(snapshot.commonDirectory, ["worktree", "move", "--", temporary, destinationPath]);
    await syncFile(NodePath.join(destinationPath, ".git"));
    const restoredGit = await restoreCandidate(snapshot, journal, destinationPath);
    await syncFile(NodePath.join(restoredGit.gitDirectory, "gitdir"));
    await syncDirectory(restoredGit.gitDirectory);
    await syncDirectory(NodePath.dirname(destinationPath));
    journal = await transition(journal, "restoring");
    await compare(snapshot, destinationPath, false);
    await NodeFSP.rmdir(NodePath.dirname(temporary));
    await syncDirectory(NodePath.dirname(destinationPath));
    journal = await transition(journal, "restored");
    return { path: destinationPath, branch: branch!, head: snapshot.head, journal };
  };
  const resumeRestore = async (id: string) => {
    const snapshot = await verify(id);
    let journal = await readJournal(id);
    if (
      journal.phase !== "restoring" ||
      journal.restorePath === undefined ||
      journal.destinationPath === undefined
    )
      refuse("the operation is not restoring");
    if (!(await exists(journal.restorePath!)) && (await exists(journal.destinationPath!)))
      return publishRestore(id);
    const container = restoreContainer(id, journal);
    if (await exists(container)) {
      await privateDirectory(container);
      if (
        journal.restoreContainerIdentity !== undefined &&
        !sameIdentity(identity(await NodeFSP.lstat(container)), journal.restoreContainerIdentity)
      )
        refuse("the restore container identity changed");
      if (
        journal.restoreContainerIdentity === undefined &&
        (await NodeFSP.readdir(container)).length !== 0
      )
        refuse("the restore container has no durable ownership record");
    } else await privateDirectory(container);
    journal = await transition(journal, "restoring", {
      restoreContainerIdentity: identity(await NodeFSP.lstat(container)),
    });
    if (await exists(journal.restorePath!)) {
      if (journal.restoreIdentity === undefined) {
        const created = await gitIdentity(journal.restorePath!);
        if (
          created.commonDirectory !== snapshot.commonDirectory ||
          created.head !== snapshot.head ||
          created.branch !== null
        )
          refuse("the incomplete restore Git identity changed");
        journal = await transition(journal, "restoring", {
          restoreIdentity: identity(await NodeFSP.lstat(journal.restorePath!)),
          restoreGitDirectory: created.gitDirectory,
        });
      }
      await restoreCandidate(snapshot, journal, journal.restorePath!);
      await populate(snapshot, journal.restorePath!, true);
    } else
      await materialize(
        snapshot,
        journal.restorePath!,
        async (restoreIdentity, restoreGitDirectory) => {
          journal = await transition(journal, "restoring", {
            restoreIdentity,
            restoreGitDirectory,
          });
        },
      );
    return publishRestore(id);
  };
  const restore = async (
    id: string,
    input: { readonly destinationPath: string; readonly branchName?: string },
  ) => {
    await stageRestore(id, input);
    return publishRestore(id);
  };
  const verifyRestored = async (id: string) => {
    const snapshot = await verify(id);
    const journal = await readJournal(id);
    if (
      !["restored", "active"].includes(journal.phase) ||
      journal.destinationPath === undefined ||
      journal.branch === undefined
    )
      refuse("the restore has no published destination");
    await restoreCandidate(snapshot, journal, journal.destinationPath!);
    await compare(snapshot, journal.destinationPath!, false);
    return {
      path: journal.destinationPath!,
      branch: journal.branch!,
      head: snapshot.head,
      journal,
    };
  };
  const finalizeRestore = async (id: string) => {
    const snapshot = await read(id);
    const journal = await readJournal(id);
    if (journal.phase !== "restored" || journal.destinationPath === undefined)
      refuse("the restore has not been verified");
    await compare(snapshot, journal.destinationPath!, false);
    return transition(journal, "active");
  };
  const beginDiscard = async (id: string) => {
    const snapshot = await read(id);
    const journal = await readJournal(id);
    if (!["suspended", "active"].includes(journal.phase))
      refuse("an unfinished operation still needs these saved files");
    if (journal.isolatedPath !== undefined && (await exists(journal.isolatedPath)))
      refuse("isolated recovery remnants still need reconciliation");
    if (journal.trialPath !== undefined && (await exists(journal.trialPath)))
      refuse("trial recovery still needs reconciliation");
    const { commonDirectory, commonIdentity, headRef, head, indexRef, indexTree, gitRefs } =
      snapshot;
    return transition(journal, "discard-intent", {
      discardPreviousPhase: journal.phase === "active" ? "active" : "suspended",
      discard: { commonDirectory, commonIdentity, headRef, head, indexRef, indexTree, gitRefs },
    });
  };
  const cancelDiscardIntent = async (id: string) => {
    const journal = await readJournal(id);
    if (
      ["active", "suspended"].includes(journal.phase) &&
      journal.discard === undefined &&
      journal.discardPreviousPhase === undefined
    )
      return journal;
    if (
      journal.phase !== "discard-intent" ||
      journal.discard === undefined ||
      !["active", "suspended"].includes(journal.discardPreviousPhase ?? "")
    )
      refuse("saved-data disposal cannot be cancelled after commitment");
    await verify(id);
    const { discard: _discard, discardPreviousPhase: previous, ...retained } = journal;
    return transition(retained, previous!);
  };
  // The caller must commit the exact owner/generation consent before this boundary.
  const commitDiscard = async (id: string) => {
    const journal = await readJournal(id);
    if (journal.phase !== "discard-intent" || journal.discard === undefined)
      refuse("there is no exact saved-data disposal intent");
    return transition(journal, "discarding");
  };
  const releaseSnapshotRefs = async (
    id: string,
    saved: NonNullable<WorktreeSuspensionJournal["discard"]>,
  ) => {
    if (
      saved.headRef !== `refs/lastcode/suspension/${id}/head` ||
      saved.indexRef !== `refs/lastcode/suspension/${id}/index`
    )
      refuse("the disposal refs do not match");
    for (const [index, ref] of saved.gitRefs.entries())
      if (
        ref.ref !== `refs/lastcode/suspension/${id}/metadata/${index}` ||
        !/^[a-f0-9]{40,64}$/u.test(ref.object)
      )
        refuse("the disposal metadata refs do not match");
    await noLinkedAncestors(saved.commonDirectory);
    if (!sameIdentity(identity(await NodeFSP.stat(saved.commonDirectory)), saved.commonIdentity))
      refuse("the disposal repository identity changed");
    const expected = new Map([
      [saved.headRef, saved.head],
      [saved.indexRef, saved.indexTree],
      ...saved.gitRefs.map((item) => [item.ref, item.object] as const),
    ]);
    const actual = await gitText(saved.commonDirectory, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/lastcode/suspension/${id}/`,
    ]);
    const deletes: Array<string> = [];
    for (const line of actual.split("\n").filter(Boolean)) {
      const [ref, object] = line.split(" ");
      if (expected.get(ref!) !== object) refuse("the disposal ref changed");
      deletes.push(`delete ${ref} ${object}\n`);
    }
    if (deletes.length > 0)
      await git(saved.commonDirectory, ["update-ref", "--stdin"], undefined, deletes.join(""));
    const directories = new Set([saved.commonDirectory]);
    for (const ref of expected.keys()) {
      let directory = NodePath.dirname(NodePath.join(saved.commonDirectory, ref));
      while (within(saved.commonDirectory, directory)) {
        if (await exists(directory)) directories.add(directory);
        if (directory === saved.commonDirectory) break;
        directory = NodePath.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length))
      await syncDirectory(directory);
  };
  const cleanupIncompleteCapture = async (id: string, input: { readonly operationId: string }) => {
    let journal = await readJournal(id);
    if (journal.operationId !== input.operationId)
      refuse("the incomplete capture operation changed");
    if (journal.phase === "capture-cancelled") return journal;
    if (
      !["capturing", "capture-cleanup"].includes(journal.phase) ||
      (await exists(snapshotPath(id))) ||
      journal.sourcePath === undefined ||
      journal.sourceIdentity === undefined ||
      journal.isolatedPath !== undefined ||
      journal.restorePath !== undefined ||
      journal.trialPath !== undefined
    )
      refuse("a complete or unresolved recovery source cannot be removed as an incomplete capture");
    await noLinkedAncestors(journal.sourcePath!);
    if (!sameIdentity(identity(await NodeFSP.lstat(journal.sourcePath!)), journal.sourceIdentity!))
      refuse("the original workspace identity changed");
    const root = snapshotDirectory(id);
    const rootIdentity = identity(await NodeFSP.lstat(root));
    const files = new Map<string, string>();
    const admitFile = async (filename: string) => {
      const stat = await NodeFSP.lstat(filename);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        refuse("an incomplete saved artifact is redirected or not private");
      files.set(filename, version(stat));
    };
    let objectsIdentity: FileIdentity | undefined;
    for (const name of await NodeFSP.readdir(root)) {
      if (name === "journal.json") continue;
      if (name === "objects") {
        await privateDirectory(objectsPath(id));
        objectsIdentity = identity(await NodeFSP.lstat(objectsPath(id)));
        const names = await NodeFSP.readdir(objectsPath(id));
        if (names.length > limits.maxEntries + gitLimits.maxEntries)
          refuse("the incomplete saved inventory exceeds its limit");
        for (const object of names) {
          if (!/^(?:[a-f0-9]{64}\.gz|[a-f0-9-]{36}\.tmp)$/u.test(object))
            refuse("unknown additions in an incomplete capture are retained");
          await admitFile(NodePath.join(objectsPath(id), object));
        }
      } else {
        if (
          !/^(?:capture-index|index-[a-f0-9-]{36}|(?:journal|manifest)\.json\.[a-f0-9-]{36}\.tmp)$/u.test(
            name,
          )
        )
          refuse("unknown additions in an incomplete capture are retained");
        await admitFile(NodePath.join(root, name));
      }
    }
    journal = await transition(journal, "capture-cleanup");
    if (journal.captureRefs !== undefined) await releaseSnapshotRefs(id, journal.captureRefs);
    for (const [filename, token] of files) {
      if (!(await exists(filename))) continue;
      if (
        !sameIdentity(identity(await NodeFSP.lstat(root)), rootIdentity) ||
        version(await NodeFSP.lstat(filename)) !== token
      )
        refuse("an incomplete saved artifact changed during cleanup");
      await NodeFSP.unlink(filename);
    }
    if (objectsIdentity !== undefined && (await exists(objectsPath(id)))) {
      if (!sameIdentity(identity(await NodeFSP.lstat(objectsPath(id))), objectsIdentity))
        refuse("the incomplete payload directory changed");
      await NodeFSP.rmdir(objectsPath(id));
    }
    await syncDirectory(root);
    return transition(journal, "capture-cancelled");
  };
  const purgeDiscard = async (id: string) => {
    const journal = await readJournal(id);
    if (journal.phase !== "discarding" || journal.discard === undefined)
      refuse("saved-data disposal has not been committed");
    await releaseSnapshotRefs(id, journal.discard);
    if (await exists(objectsPath(id))) {
      await privateDirectory(objectsPath(id));
      await NodeFSP.rm(objectsPath(id), { recursive: true });
    }
    if (await exists(snapshotPath(id))) await NodeFSP.unlink(snapshotPath(id));
    for (const name of await NodeFSP.readdir(snapshotDirectory(id))) {
      if (name === "journal.json") continue;
      if (
        !/^(index-[a-f0-9-]{36}|capture-index|(journal|manifest)\.json\.[a-f0-9-]{36}\.tmp)$/u.test(
          name,
        )
      )
        refuse("extra saved artifacts still need reconciliation");
      const filename = NodePath.join(snapshotDirectory(id), name);
      const stat = await NodeFSP.lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
        refuse("a temporary saved artifact identity changed");
      await NodeFSP.unlink(filename);
    }
    await syncDirectory(snapshotDirectory(id));
    return transition(journal, "discarded");
  };
  const discard = async (id: string, input: { readonly commit: () => Promise<void> }) => {
    await beginDiscard(id);
    await input.commit();
    await commitDiscard(id);
    return purgeDiscard(id);
  };
  const createFresh = async (input: {
    readonly operationId: string;
    readonly repositoryRoot: string;
    readonly destinationPath: string;
    readonly head: string;
    readonly branchName: string;
  }) => {
    await initialize();
    const operationId = validId(input.operationId);
    const directory = snapshotDirectory(`fresh-${operationId}`);
    await privateDirectory(directory);
    const filename = NodePath.join(directory, "fresh.json");
    const destination = NodePath.resolve(input.destinationPath);
    const container = NodePath.join(
      NodePath.dirname(destination),
      `.suspension-fresh-${operationId}`,
    );
    const checkout = NodePath.join(container, "checkout");
    const branch = `refs/heads/${input.branchName}`;
    if (
      !/^[a-f0-9]{40,64}$/u.test(input.head) ||
      !input.branchName.startsWith("suspension/fresh-") ||
      within(storeRoot, destination) ||
      within(destination, storeRoot)
    )
      refuse("the fresh-worktree request is invalid");
    await noLinkedAncestors(NodePath.dirname(destination));
    const commonDirectory = await NodeFSP.realpath(
      await gitText(input.repositoryRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    const commonIdentity = identity(await NodeFSP.lstat(commonDirectory));
    if (
      (await gitText(commonDirectory, ["rev-parse", "--verify", `${input.head}^{commit}`])) !==
      input.head
    )
      refuse("the fresh-worktree base is unavailable");
    await git(commonDirectory, ["check-ref-format", branch]);
    type FreshJournal = {
      version: 1;
      operationId: string;
      head: string;
      branch: string;
      destination: string;
      commonDirectory: string;
      commonIdentity: FileIdentity;
      containerIdentity?: FileIdentity;
      checkoutIdentity?: FileIdentity;
      gitDirectory?: string;
      gitDirectoryIdentity?: FileIdentity;
      published?: boolean;
    };
    let journal: FreshJournal;
    if (await exists(filename)) {
      const handle = await NodeFSP.open(
        filename,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > 64 * 1024 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          refuse("the fresh-worktree journal is invalid");
        journal = JSON.parse(await handle.readFile("utf8")) as FreshJournal;
      } finally {
        await handle.close();
      }
      if (
        journal!.version !== 1 ||
        journal!.operationId !== operationId ||
        journal!.head !== input.head ||
        journal!.branch !== branch ||
        journal!.destination !== destination ||
        journal!.commonDirectory !== commonDirectory ||
        !sameIdentity(journal!.commonIdentity, commonIdentity)
      )
        refuse("the fresh-worktree authority changed");
    } else {
      if ((await exists(destination)) || (await exists(container)))
        refuse("the fresh-worktree destination is occupied");
      journal = {
        version: 1,
        operationId,
        head: input.head,
        branch,
        destination,
        commonDirectory,
        commonIdentity,
      };
      await atomicJson(filename, journal);
    }
    const listing = (
      await git(commonDirectory, ["ls-tree", "-r", "-t", "-z", "--long", input.head])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const expected = new Map<string, { mode: string; object: string; size: number }>();
    let bytes = 0;
    for (const line of listing) {
      const match = /^(\d+) (?:blob|tree|commit) ([a-f0-9]+) +([\d-]+)\t(.+)$/u.exec(line);
      if (match === null) refuse("the fresh-worktree tree is unsupported");
      validRelativePath(match![4]!);
      const size = match![3] === "-" ? 0 : Number(match![3]);
      if (
        size > limits.maxFileBytes ||
        (bytes += size) > limits.maxBytes ||
        expected.size >= limits.maxEntries
      )
        refuse("the fresh-worktree exceeds preservation limits");
      expected.set(match![4]!, { mode: match![1]!, object: match![2]!, size });
    }
    await freeSpace(NodePath.dirname(destination), bytes + 64 * 1024 * 1024);
    const rawHash = async (absolute: string, size: number) => {
      const hash = NodeCrypto.createHash(input.head.length === 40 ? "sha1" : "sha256");
      hash.update(`blob ${size}\0`);
      const file = await NodeFSP.open(
        absolute,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      } finally {
        await file.close();
      }
      return hash.digest("hex");
    };
    const checkContents = async (root: string, complete: boolean) => {
      const current = await inventory(root, limits);
      if (current.hardlinks !== undefined)
        refuse("the fresh-worktree contains unexpected hardlinked files");
      const present = new Set<string>();
      for (const entry of current.entries) {
        const saved = expected.get(entry.path);
        if (saved === undefined)
          refuse("unknown files appeared in the fresh-worktree staging area");
        present.add(entry.path);
        const absolute = NodePath.join(root, entry.path);
        if (entry.kind === "directory") {
          if (saved!.mode !== "040000" && saved!.mode !== "160000")
            refuse("the fresh-worktree path kind changed");
          if (saved!.mode === "160000" && (await NodeFSP.readdir(absolute)).length !== 0)
            refuse("populated submodules are unsupported");
        } else if (entry.kind === "symlink") {
          const raw = Buffer.from(entry.target);
          const object = NodeCrypto.createHash(input.head.length === 40 ? "sha1" : "sha256")
            .update(`blob ${raw.length}\0`)
            .update(raw)
            .digest("hex");
          if (saved!.mode !== "120000" || object !== saved!.object)
            refuse("the fresh-worktree symlink changed");
        } else {
          if (
            !["100644", "100755"].includes(saved!.mode) ||
            (entry.mode & 0o111) !== (saved!.mode === "100755" ? 0o111 : 0)
          )
            refuse("the fresh-worktree mode changed");
          if ((await rawHash(absolute, entry.size)) !== saved!.object) {
            if (complete || entry.size >= saved!.size) refuse("the fresh-worktree file changed");
            const contents = await git(commonDirectory, ["cat-file", "blob", saved!.object]);
            if (!contents.subarray(0, entry.size).equals(await NodeFSP.readFile(absolute)))
              refuse("the incomplete fresh-worktree file changed");
          }
        }
      }
      if (
        complete &&
        [...expected].some(([name, entry]) => entry.mode !== "160000" && !present.has(name))
      )
        refuse("the fresh-worktree is incomplete");
      return current;
    };
    let root = checkout;
    if (await exists(destination)) {
      if (journal!.checkoutIdentity === undefined || (await exists(checkout)))
        refuse("the fresh-worktree destination is occupied");
      root = destination;
    } else {
      if (await exists(container)) {
        await privateDirectory(container);
        if (
          journal!.containerIdentity === undefined &&
          (await NodeFSP.readdir(container)).length !== 0
        )
          refuse("the fresh-worktree staging area has no ownership proof");
        if (
          journal!.containerIdentity !== undefined &&
          !sameIdentity(identity(await NodeFSP.lstat(container)), journal!.containerIdentity)
        )
          refuse("the fresh-worktree staging area changed");
      } else await privateDirectory(container);
      journal = { ...journal!, containerIdentity: identity(await NodeFSP.lstat(container)) };
      await atomicJson(filename, journal);
      if (!(await exists(checkout)))
        await git(commonDirectory, [
          "worktree",
          "add",
          "--no-checkout",
          "--detach",
          "--",
          checkout,
          input.head,
        ]);
    }
    const current = await gitIdentity(root);
    if (
      current.commonDirectory !== commonDirectory ||
      current.head !== input.head ||
      (current.branch !== null && current.branch !== branch) ||
      (journal!.checkoutIdentity !== undefined &&
        !sameIdentity(identity(await NodeFSP.lstat(root)), journal!.checkoutIdentity)) ||
      (journal!.gitDirectoryIdentity !== undefined &&
        (!sameIdentity(current.gitDirectoryIdentity, journal!.gitDirectoryIdentity) ||
          current.gitDirectory !== journal!.gitDirectory))
    )
      refuse("the fresh-worktree Git identity changed");
    if (
      journal!.checkoutIdentity === undefined &&
      (await inventory(root, limits)).entries.length !== 0
    )
      refuse("the fresh-worktree was populated before its identity was recorded");
    journal = {
      ...journal!,
      checkoutIdentity: identity(await NodeFSP.lstat(root)),
      gitDirectory: current.gitDirectory,
      gitDirectoryIdentity: current.gitDirectoryIdentity,
    };
    await atomicJson(filename, journal);
    await checkContents(root, root === destination);
    if (root === checkout) {
      await git(root, ["read-tree", "--reset", input.head]);
      const filterKeys = (await git(root, ["config", "--null", "--name-only", "--list"]))
        .toString("utf8")
        .split("\0");
      const filterNames = new Set(
        filterKeys.flatMap(
          (key) => /^filter\.(.*)\.(?:clean|smudge|process|required)$/u.exec(key)?.[1] ?? [],
        ),
      );
      const configuration = [...filterNames].flatMap((name) => [
        "-c",
        `filter.${name}.smudge=cat`,
        "-c",
        `filter.${name}.clean=cat`,
        "-c",
        `filter.${name}.process=`,
        "-c",
        `filter.${name}.required=false`,
      ]);
      await git(root, [
        "-c",
        "core.autocrlf=false",
        "-c",
        "submodule.recurse=false",
        ...configuration,
        "checkout-index",
        "--all",
        "--force",
      ]);
      const contents = await checkContents(root, true);
      for (const entry of contents.entries)
        if (entry.kind === "file") await syncFile(NodePath.join(root, entry.path));
      for (let index = contents.entries.length - 1; index >= 0; index -= 1) {
        const entry = contents.entries[index]!;
        if (entry.kind === "directory") await syncDirectory(NodePath.join(root, entry.path));
      }
      await syncDirectory(root);
      const existingBranch = await gitText(commonDirectory, [
        "for-each-ref",
        "--format=%(objectname)",
        branch,
      ]);
      if (existingBranch !== "" && existingBranch !== input.head)
        refuse("the fresh-worktree branch changed");
      if (existingBranch === "") await git(commonDirectory, ["update-ref", branch, input.head, ""]);
      await git(root, ["symbolic-ref", "HEAD", branch]);
      await syncFile(NodePath.join(current.gitDirectory, "HEAD"));
      await syncFile(NodePath.join(current.gitDirectory, "index"));
      if (await exists(destination)) refuse("the fresh-worktree destination became occupied");
      await git(commonDirectory, ["worktree", "move", "--", checkout, destination]);
      await syncFile(NodePath.join(current.gitDirectory, "gitdir"));
      await syncFile(NodePath.join(destination, ".git"));
      await NodeFSP.rmdir(container);
      await syncDirectory(NodePath.dirname(destination));
    }
    const published = await gitIdentity(destination);
    if (
      published.head !== input.head ||
      published.branch !== branch ||
      (await gitText(destination, ["write-tree"])) !==
        (await gitText(commonDirectory, ["rev-parse", `${input.head}^{tree}`]))
    )
      refuse("the fresh-worktree publication changed");
    journal = { ...journal!, published: true };
    await atomicJson(filename, journal);
    return { path: destination, branch, head: input.head };
  };
  const inspectSource = async (sourcePath: string, purpose: "capture" | "activity" = "capture") => {
    const source = NodePath.resolve(sourcePath);
    return {
      ...(await gitIdentity(source, purpose)),
      sourceIdentity: identity(await NodeFSP.lstat(source)),
    };
  };
  return {
    capture,
    inspectSource,
    inspectActiveSource: (sourcePath: string) => inspectSource(sourcePath, "activity"),
    createFresh,
    read,
    readJournal,
    verify,
    trialRestore,
    isolate,
    verifyIsolated,
    removeIsolated,
    prepareRemoval,
    finishRemoval,
    rollbackIsolation,
    reconcileRemoval,
    keepOriginal,
    suspend,
    restore,
    stageRestore,
    publishRestore,
    resumeRestore,
    finalizeRestore,
    verifyRestored,
    beginDiscard,
    cancelDiscardIntent,
    cleanupIncompleteCapture,
    commitDiscard,
    purgeDiscard,
    discard,
  };
};
