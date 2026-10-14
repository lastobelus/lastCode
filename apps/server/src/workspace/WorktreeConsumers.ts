import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Process links, maps, and lstat are native safety boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeBuffer from "node:buffer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState, isProcessAlive } from "../serverRuntimeState.ts";
import * as DependencyMounts from "./DependencyMounts.ts";

const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_PATHS = 100_000;
const MAX_TARGET_OBJECTS = 1_000_000;
const nativeIdentities = Symbol("captured vnode identities");
type ObjectIdentity = { readonly device: bigint | null; readonly inode: bigint };
type CapturedPaths = ReadonlyArray<string> & {
  readonly [nativeIdentities]?: ReadonlyArray<ObjectIdentity | null>;
};
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState));
const gone = (error: unknown) =>
  ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
const stripDeleted = (path: string) => path.replace(/ \(deleted\)$/, "");
const within = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const readBounded = async (path: string) => {
  const file = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= MAX_INVENTORY_BYTES) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, MAX_INVENTORY_BYTES + 1 - length),
        null,
      );
      if (bytesRead === 0) return Buffer.concat(chunks).toString("utf8");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      length += bytesRead;
    }
    throw new Error("Process inventory limit exceeded");
  } finally {
    await file.close();
  }
};

const mappedPaths = (table: string): string[] | null => {
  if (table.includes("\uFFFD") || (table !== "" && !table.endsWith("\n"))) return null;
  const paths: string[] = [];
  for (const line of table.split("\n")) {
    if (line === "") continue;
    const match =
      /^[\da-f]+-[\da-f]+ [r-][w-][x-][ps] [\da-f]+ [\da-f]+:[\da-f]+ \d+(?: +(.*))?$/.exec(line);
    if (!match) return null;
    const name = stripDeleted(match[1] ?? "");
    // Kernel maps escape newline names, which cannot safely be resolved as raw paths.
    if (name.startsWith("/") && !name.includes("\\")) paths.push(name);
    else if (name !== "" && !/^\[[^\]\n]+\]$/.test(name)) return null;
  }
  return paths;
};

const linuxPaths = async (uid: number): Promise<ReadonlyArray<string> | null> => {
  const paths: string[] = [];
  const deadline = performance.now() + 10_000;
  const processes = await NodeFSP.readdir("/proc");
  if (processes.length > MAX_PROCESS_PATHS) return null;
  for (const pid of processes) {
    if (performance.now() > deadline) return null;
    if (!/^\d+$/.test(pid)) continue;
    const root = `/proc/${pid}`;
    try {
      if ((await NodeFSP.stat(root)).uid !== uid) continue;
      const references = await Promise.all([
        NodeFSP.readlink(`${root}/cwd`),
        NodeFSP.readlink(`${root}/exe`),
      ]);
      if (references.some((path) => !NodePath.isAbsolute(path) || path.includes("\uFFFD")))
        return null;
      paths.push(...references.map(stripDeleted));
      const descriptors = await NodeFSP.readdir(`${root}/fd`);
      if (descriptors.length + paths.length > MAX_PROCESS_PATHS) return null;
      for (const descriptor of descriptors) {
        if (performance.now() > deadline) return null;
        if (!/^\d+$/.test(descriptor)) return null;
        try {
          const target = stripDeleted(await NodeFSP.readlink(`${root}/fd/${descriptor}`));
          if (target.includes("\uFFFD")) return null;
          if (NodePath.isAbsolute(target)) paths.push(target);
          else if (!/^(?:socket:\[\d+\]|pipe:\[\d+\]|anon_inode:.*)$/.test(target)) return null;
        } catch (error) {
          if (!gone(error)) throw error; // An fd can close while it is being observed.
        }
      }
      const mapped = mappedPaths(await readBounded(`${root}/maps`));
      if (mapped === null || paths.length + mapped.length > MAX_PROCESS_PATHS) return null;
      paths.push(...mapped);
    } catch (error) {
      if (!gone(error)) return null;
      // Missing required evidence is safe only when the whole process vanished.
      try {
        await NodeFSP.stat(root);
        return null;
      } catch (statError) {
        if (!gone(statError)) return null;
      }
    }
  }
  return paths.length > 0 ? paths : null;
};

const cEscapeBytes = new Map([
  [92, 92],
  [98, 8],
  [102, 12],
  [114, 13],
  [110, 10],
  [116, 9],
]);

const decodeLsofPath = (printed: string): string | null => {
  const input = NodeBuffer.Buffer.from(printed, "utf8");
  if (input.toString("utf8") !== printed) return null;
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const byte = input[index]!;
    if (byte === 92) {
      const escaped = input[++index];
      if (escaped === 120) {
        const hex = input.subarray(index + 1, index + 3).toString("utf8");
        if (!/^[\da-fA-F]{2}$/.test(hex)) return null;
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        const decoded = cEscapeBytes.get(escaped ?? -1);
        if (decoded === undefined) return null;
        bytes.push(decoded);
      }
    } else {
      // lsof's safepup uses caret notation for controls but safestrprt leaves
      // literal '^' printable. These raw shapes cannot be uniquely inverted.
      const next = input[index + 1];
      if (byte === 94 && next !== undefined && (next === 63 || (next >= 64 && next <= 95)))
        return null;
      if (byte < 32 || byte === 127) return null;
      bytes.push(byte);
    }
  }
  const decoded = NodeBuffer.Buffer.from(bytes);
  if (decoded.includes(0) || !NodeBuffer.isUtf8(decoded)) return null;
  return decoded.toString("utf8");
};

const lsofPaths = (output: string): ReadonlyArray<string> | null => {
  if (!output.endsWith("\0\n") || output.includes("\uFFFD")) return null;
  const paths: string[] = [];
  const identities: Array<ObjectIdentity | null> = [];
  let processes = 0;
  let cwdSeen = false;
  let file:
    | { descriptor: string; type?: string; name?: string; device?: string; inode?: string }
    | undefined;
  const finishFile = () => {
    if (!file) return true;
    // Darwin lsof emits this exact marker when its numeric-FD vnode-path query
    // returns ENOENT. It is a no-current-path observation, like a vanished Linux
    // fd, not proof of revocation. Keep cwd/text, fileport and other missing-type
    // evidence protected. Vendor source: lsof-org/lsof, darwin/dfile.c process_vnode.
    if (!file.type)
      return file.type === undefined && /^\d+$/.test(file.descriptor) && file.name === "(revoked)";
    if (file.name?.startsWith("/")) {
      // Hex escapes represent UTF-8 bytes, not individual Unicode characters.
      // Decode once so doubled backslashes keep literal escape-looking names.
      const name = decodeLsofPath(file.name);
      if (name === null) return false;
      paths.push(stripDeleted(name));
      const inode = file.inode === undefined ? null : BigInt(file.inode);
      // Darwin omits the device field for FIFO vnodes. A positive inode can
      // still prove absence only by treating every same-inode target as a match.
      const fifoWithoutDevice = file.type === "FIFO" && /^\d+$/.test(file.descriptor);
      identities.push(
        inode !== null && inode > 0n && (file.device !== undefined || fifoWithoutDevice)
          ? Object.freeze({ device: file.device === undefined ? null : BigInt(file.device), inode })
          : null,
      );
      if (file.descriptor === "cwd") cwdSeen = true;
      return paths.length <= MAX_PROCESS_PATHS;
    }
    if (file.descriptor === "cwd" || file.descriptor === "txt") return false;
    return [
      "IPv4",
      "IPv6",
      "unix",
      "PIPE",
      "NPOLICY",
      "CHAN",
      "NEXUS",
      "KQUEUE",
      "PSXSEM",
      "PSXSHM",
      "systm",
    ].includes(file.type);
  };
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (field === "") continue;
    const value = field.slice(1);
    switch (field[0]) {
      case "p":
        if (!/^\d+$/.test(value) || !finishFile() || (processes > 0 && !cwdSeen)) return null;
        if (++processes > MAX_PROCESS_PATHS) return null;
        cwdSeen = false;
        file = undefined;
        break;
      case "f":
        if (processes === 0 || value === "" || !finishFile()) return null;
        file = { descriptor: value };
        break;
      case "t":
        if (!file || file.type || value === "") return null;
        file.type = value;
        break;
      case "n":
        if (!file || file.name !== undefined) return null;
        file.name = value;
        break;
      case "D":
        if (!file || file.device !== undefined || !/^0x[\da-fA-F]+$/.test(value)) return null;
        file.device = value;
        break;
      case "i":
        if (!file || file.inode !== undefined || !/^\d+$/.test(value)) return null;
        file.inode = value;
        break;
      default:
        return null;
    }
  }
  if (!finishFile() || !cwdSeen || processes === 0) return null;
  Object.defineProperty(paths, nativeIdentities, { value: Object.freeze(identities) });
  return Object.freeze(paths);
};

const processPaths = async (platform: NodeJS.Platform, uid: number | undefined) => {
  if (uid === undefined) return null;
  if (platform === "linux") return linuxPaths(uid);
  if (platform !== "darwin") return null;
  return await new Promise<ReadonlyArray<string> | null>((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-a", "-u", String(uid), "-F0pftnDi", "-n", "-P"],
      { timeout: 10_000, maxBuffer: MAX_INVENTORY_BYTES },
      (error, stdout, stderr) => resolve(error || stderr.trim() !== "" ? null : lsofPaths(stdout)),
    );
  });
};

/** Actual file consumers, observed afresh; generic startup does not renew usage clocks. */
export class ProcessPaths extends Context.Reference<Effect.Effect<ReadonlyArray<string> | null>>(
  "t3/workspace/WorktreeProcessPaths",
  {
    defaultValue: () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const uid = yield* HostProcess.UserId;
        return yield* Effect.tryPromise({
          try: () => processPaths(platform, uid),
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
      }),
  },
) {}

const identityKey = ({ device, inode }: ObjectIdentity) => `${device}:${inode}`;
const directoryToken = (stat: Awaited<ReturnType<typeof targetStat>>) =>
  `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
const targetStat = (path: string) => NodeFSP.lstat(path, { bigint: true });

const targetIdentities = async (root: string) => {
  const deadline = performance.now() + 30_000;
  const rootStat = await targetStat(root);
  if (!rootStat.isDirectory() || (await NodeFSP.realpath(root)) !== root)
    throw new Error("Consumer target root is not a canonical directory");
  const directories: Array<{ path: string; token: string }> = [];
  const identities = new Set<string>();
  const inodes = new Set<bigint>();
  let objects = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++objects > MAX_TARGET_OBJECTS || depth > 128 || performance.now() > deadline)
      throw new Error("Consumer target inventory limit exceeded");
    const stat = await targetStat(path);
    if (
      typeof stat.dev !== "bigint" ||
      typeof stat.ino !== "bigint" ||
      stat.ino <= 0n ||
      stat.dev !== rootStat.dev
    )
      throw new Error("Consumer target object identity is unavailable or crosses a device");
    identities.add(identityKey({ device: stat.dev, inode: stat.ino }));
    inodes.add(stat.ino);
    if (!stat.isDirectory()) return; // Record links themselves; never traverse their targets.
    if (typeof stat.mtimeNs !== "bigint" || typeof stat.ctimeNs !== "bigint")
      throw new Error("Consumer target directory timestamps are unavailable");
    const token = directoryToken(stat);
    directories.push({ path, token });
    const directory = await NodeFSP.opendir(path);
    for await (const entry of directory) {
      if (entry.name === "." || entry.name === ".." || NodePath.basename(entry.name) !== entry.name)
        throw new Error("Consumer target directory entry is malformed");
      await visit(NodePath.join(path, entry.name), depth + 1);
    }
    if (directoryToken(await targetStat(path)) !== token)
      throw new Error("Consumer target directory changed during observation");
  };
  await visit(root, 0);
  for (const directory of directories) {
    if (
      performance.now() > deadline ||
      directoryToken(await targetStat(directory.path)) !== directory.token
    )
      throw new Error("Consumer target directory changed during observation");
  }
  if (
    directoryToken(await targetStat(root)) !== directoryToken(rootStat) ||
    (await NodeFSP.realpath(root)) !== root
  )
    throw new Error("Consumer target root changed during observation");
  return { identities, inodes };
};

/**
 * Captured Darwin D/i fields describe the opened vnode's stat identity, not an
 * unconditional canonical pathname. Only an unresolved captured object can use
 * a complete, unchanged no-follow target inventory as an alternative alias proof.
 * Callers retain fresh mount protection under the canonical workspace lease.
 */
export const processPathsUseRoot = async (
  canonicalRoot: string,
  paths: ReadonlyArray<string>,
): Promise<boolean> => {
  if (!NodePath.isAbsolute(canonicalRoot)) throw new Error("Consumer target root is not absolute");
  const captured = (paths as CapturedPaths)[nativeIdentities];
  const unresolved: ObjectIdentity[] = [];
  for (const [index, path] of paths.entries()) {
    if (!NodePath.isAbsolute(path)) throw new Error("Process consumer path is not absolute");
    if (within(canonicalRoot, path)) return true;
    try {
      if (within(canonicalRoot, await NodeFSP.realpath(path))) return true;
    } catch (error) {
      if (
        !gone(error) &&
        !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
      if (captured === undefined) {
        if (!gone(error)) throw error;
        continue;
      }
      const identity = captured[index];
      if (!identity)
        throw new Error("Unresolved process object identity is unavailable", { cause: error });
      if (identity.device === null && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Device-unknown FIFO evidence is not a vanished pathname", {
          cause: error,
        });
      unresolved.push(identity);
    }
  }
  if (unresolved.length === 0) return false;
  const identities = await targetIdentities(canonicalRoot);
  return unresolved.some((identity) =>
    identity.device === null
      ? identities.inodes.has(identity.inode)
      : identities.identities.has(identityKey(identity)),
  );
};

const runtimeKeptReason = async (root: string): Promise<string | null> => {
  for (const location of ["userdata", "dev"]) {
    let directory = root;
    let absent = false;
    for (const component of [".t3", location]) {
      directory = NodePath.join(directory, component);
      try {
        if (!(await NodeFSP.lstat(directory)).isDirectory())
          return "Runtime state path is not a regular directory.";
      } catch (error) {
        if (!gone(error)) throw error;
        absent = true;
        break;
      }
    }
    if (absent) continue;
    const target = NodePath.join(directory, "server-runtime.json");
    let stat;
    try {
      stat = await NodeFSP.lstat(target);
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > 64 * 1024) return "Runtime descriptor cannot be safely read.";
    try {
      const state = decodeRuntime(await NodeFSP.readFile(target, "utf8"));
      if (state.pid <= 0 || isProcessAlive(state.pid)) return "A server runtime is still active.";
    } catch {
      return "Runtime descriptor cannot be safely read.";
    }
  }
  return null;
};

/** Call under the canonical workspace lease immediately before removing generated files or a checkout. */
export const worktreeConsumerReason = Effect.fn("WorktreeConsumers.worktreeConsumerReason")(
  function* (canonicalRoot: string, capturedPaths?: ReadonlyArray<string> | null) {
    const paths = capturedPaths === undefined ? yield* yield* ProcessPaths : capturedPaths;
    if (paths === null) return "Process file-consumer inventory is unavailable.";
    const mounts = yield* yield* DependencyMounts.MountPoints;
    if (mounts === null) return "Mount inventory is unavailable.";
    if (DependencyMounts.containsMount(canonicalRoot, mounts))
      return "A mounted path is inside the worktree.";
    return yield* Effect.tryPromise({
      try: async (): Promise<string | null> => {
        if (
          !NodePath.isAbsolute(canonicalRoot) ||
          (await NodeFSP.realpath(canonicalRoot)) !== canonicalRoot
        )
          return "Worktree root is not canonical.";
        if (await processPathsUseRoot(canonicalRoot, paths))
          return "A process is using a file or directory in the worktree.";
        return runtimeKeptReason(canonicalRoot);
      },
      catch: () => "Worktree consumer protection could not be verified.",
    }).pipe(Effect.catch((reason) => Effect.succeed(reason)));
  },
);
