import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Process links, maps, and lstat are native safety boundaries.
import { promises as NodeFSP } from "@t3tools/shared/nativeFileSystem";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeBuffer from "node:buffer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  STORAGE_CLEANUP_INVENTORY_ATTRIBUTE,
  emptyStorageCleanupInventoryTrace,
  type StorageCleanupWalkTrigger,
} from "../observability/StorageCleanupInventoryTrace.ts";
import { PersistedServerRuntimeState, isProcessAlive } from "../serverRuntimeState.ts";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";
import * as DependencyMounts from "./DependencyMounts.ts";

const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_PATHS = 100_000;
const MAX_TARGET_OBJECTS = 1_000_000;
const MAX_DIAGNOSTIC_PROCESS_NAME_LENGTH = 64;
const MAX_TRACE_WALK_TRIGGERS = 32;
const nativeIdentities = Symbol("captured vnode identities");
const nativeProcesses = Symbol("captured process names");
type ObjectIdentity = { readonly device: bigint | null; readonly inode: bigint };
type CapturedObject = ObjectIdentity | "unix-socket" | null;
type WalkTrigger = Omit<StorageCleanupWalkTrigger, "walks">;
type CapturedPaths = ReadonlyArray<string> & {
  readonly [nativeIdentities]?: ReadonlyArray<CapturedObject>;
  readonly [nativeProcesses]?: ReadonlyArray<string>;
};
// @effect-diagnostics-next-line extendsNativeError:off -- Native Promise inventory throws this sentinel; worktreeConsumerReason maps it into the Effect failure channel.
class ObjectProofUnavailable extends Error {}
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

const sanitizeProcessName = (printed: string): string => {
  if (printed.includes("\uFFFD")) return "unknown";
  const decoded = decodeLsofPath(printed);
  if (decoded === null || decoded.includes("\uFFFD")) return "unknown";
  const base = decoded.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "";
  const cleaned = base.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, "").trim();
  const sanitized = Array.from(cleaned)
    .slice(0, MAX_DIAGNOSTIC_PROCESS_NAME_LENGTH)
    .join("")
    .trim();
  return sanitized === "" ? "unknown" : sanitized;
};

const lsofPaths = (
  output: string,
  emptyFdPids: ReadonlySet<number> = new Set(),
): ReadonlyArray<string> | null => {
  if (!output.endsWith("\0\n")) return null;
  const paths: string[] = [];
  const identities: CapturedObject[] = [];
  const processesByPath: string[] = [];
  let processes = 0;
  let pid = 0;
  let processName = "unknown";
  let commandSeen = false;
  const recovered = new Set<number>();
  const numericPids = new Set<number>();
  let cwdSeen = false;
  let file:
    | { descriptor: string; type?: string; name?: string; device?: string; inode?: string }
    | undefined;
  const finishFile = () => {
    if (!file) return true;
    // Darwin's "err" record also covers successful empty FD lists with stale
    // errno (darwin/libproc/dproc.c process_fds). Its text cannot distinguish
    // that from a failed enumeration; accepting it needs independent OS proof.
    if (file.descriptor === "err") {
      if (
        file.type !== undefined ||
        file.device !== undefined ||
        file.inode !== undefined ||
        file.name !== "FD info error: Invalid argument" ||
        !emptyFdPids.has(pid) ||
        recovered.has(pid)
      )
        return false;
      recovered.add(pid);
      return true;
    }
    // Darwin lsof emits this exact marker when its numeric-FD vnode-path query
    // returns ENOENT. It is a no-current-path observation, like a vanished Linux
    // fd, not proof of revocation. Keep cwd/text, fileport and other missing-type
    // evidence protected. Vendor source: lsof-org/lsof, darwin/dfile.c process_vnode.
    if (!file.type)
      return file.type === undefined && /^\d+$/.test(file.descriptor) && file.name === "(revoked)";
    // POSIX shared-memory names belong to a kernel namespace, even when they
    // start with '/'. Darwin reports these numeric descriptors without vnode D/i.
    if (file.type === "PSXSHM")
      return /^\d+$/.test(file.descriptor) && file.device === undefined && file.inode === undefined;
    if (file.name?.startsWith("/")) {
      // Hex escapes represent UTF-8 bytes, not individual Unicode characters.
      // Decode once so doubled backslashes keep literal escape-looking names.
      const name = decodeLsofPath(file.name);
      if (name === null) return false;
      paths.push(stripDeleted(name));
      processesByPath.push(processName);
      const inode = file.inode === undefined ? null : BigInt(file.inode);
      // Darwin omits the device field for FIFO vnodes. A positive inode can
      // still prove absence only by treating every same-inode target as a match.
      const fifoWithoutDevice = file.type === "FIFO" && /^\d+$/.test(file.descriptor);
      // AF_UNIX names are cached sockaddr_un addresses, not vnode D/i evidence.
      // Vendor source: lsof-org/lsof, darwin/dsock.c process_socket_common.
      identities.push(
        file.type === "unix"
          ? /^\d+$/.test(file.descriptor) && file.device === undefined && file.inode === undefined
            ? "unix-socket"
            : null
          : inode !== null && inode > 0n && (file.device !== undefined || fifoWithoutDevice)
            ? Object.freeze({
                device: file.device === undefined ? null : BigInt(file.device),
                inode,
              })
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
      "systm",
    ].includes(file.type);
  };
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (field === "") continue;
    const value = field.slice(1);
    if (field[0] !== "c" && field.includes("\uFFFD")) return null;
    switch (field[0]) {
      case "p":
        if (!/^\d+$/.test(value) || !finishFile() || (processes > 0 && !cwdSeen)) return null;
        if (++processes > MAX_PROCESS_PATHS) return null;
        pid = Number(value);
        processName = "unknown";
        commandSeen = false;
        cwdSeen = false;
        file = undefined;
        break;
      case "c":
        if (processes === 0 || file !== undefined || commandSeen) return null;
        commandSeen = true;
        processName = sanitizeProcessName(value);
        break;
      case "f":
        if (processes === 0 || value === "" || !finishFile()) return null;
        if (/^\d+$/.test(value)) numericPids.add(pid);
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
  if (recovered.size !== emptyFdPids.size || [...recovered].some((pid) => numericPids.has(pid)))
    return null;
  Object.defineProperty(paths, nativeIdentities, { value: Object.freeze(identities) });
  Object.defineProperty(paths, nativeProcesses, { value: Object.freeze(processesByPath) });
  return Object.freeze(paths);
};

const helperPaths = (
  output: string,
  uid: number,
  expectedVersion: 1 | 2,
): ReadonlyArray<string> | null => {
  const boundary = output.indexOf("\n");
  if (boundary < 0 || boundary > MAX_PROCESS_PATHS * 12 + 128) return null;
  try {
    const header = JSON.parse(output.slice(0, boundary)) as {
      version?: unknown;
      type?: unknown;
      uid?: unknown;
      emptyFdPids?: unknown;
    } | null;
    if (
      header === null ||
      header.version !== expectedVersion ||
      header.type !== "lsofCapture" ||
      header.uid !== uid ||
      !Array.isArray(header.emptyFdPids) ||
      header.emptyFdPids.length > MAX_PROCESS_PATHS ||
      header.emptyFdPids.some(
        (pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647,
      )
    )
      return null;
    const pids = new Set<number>(header.emptyFdPids);
    if (pids.size !== header.emptyFdPids.length) return null;
    const capture = output.slice(boundary + 1);
    if (NodeBuffer.Buffer.byteLength(capture) > MAX_INVENTORY_BYTES) return null;
    return lsofPaths(capture, pids);
  } catch {
    return null;
  }
};

const runHelperCapture = (
  binary: string,
  command: "capture-lsof-v1" | "capture-lsof-v2",
  uid: number,
) =>
  new Promise<{
    readonly paths: ReadonlyArray<string> | null;
    readonly unsupportedCommand: boolean;
  }>((resolve) => {
    NodeChildProcess.execFile(
      binary,
      [command, String(uid)],
      {
        timeout: 10_000,
        maxBuffer: MAX_INVENTORY_BYTES + MAX_PROCESS_PATHS * 12 + 128,
      },
      (error, stdout, stderr) =>
        resolve(
          error || stderr.trim() !== ""
            ? {
                paths: null,
                unsupportedCommand:
                  Boolean(error) && stderr.includes("Unsupported resource monitor command"),
              }
            : {
                paths: helperPaths(stdout, uid, command === "capture-lsof-v2" ? 2 : 1),
                unsupportedCommand: false,
              },
        ),
    );
  });

const captureProcessPaths = async (
  platform: NodeJS.Platform,
  uid: number,
  binary: string | null,
) => {
  if (platform === "linux") return linuxPaths(uid);
  if (platform !== "darwin") return null;
  if (binary !== null) {
    const v2 = await runHelperCapture(binary, "capture-lsof-v2", uid);
    if (v2.paths !== null || !v2.unsupportedCommand) return v2.paths;
    return (await runHelperCapture(binary, "capture-lsof-v1", uid)).paths;
  }
  return await new Promise<ReadonlyArray<string> | null>((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-a", "-u", String(uid), "-F0pcftnDi", "-n", "-P"],
      {
        timeout: 10_000,
        maxBuffer: MAX_INVENTORY_BYTES,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout, stderr) => resolve(error || stderr.trim() !== "" ? null : lsofPaths(stdout)),
    );
  });
};

const processPaths = async (
  platform: NodeJS.Platform,
  uid: number | undefined,
  binary: string | null,
  onAttempt: (() => void) | undefined,
) => {
  if (uid === undefined || (platform !== "linux" && platform !== "darwin")) return null;
  const capture = async () => {
    onAttempt?.();
    try {
      return await captureProcessPaths(platform, uid, binary);
    } catch {
      return null;
    }
  };
  const first = await capture();
  // A closing descriptor can make an observation incomplete. Retry once with
  // an entirely new inventory; no paths or object evidence survive a failed one.
  return first === null ? capture() : first;
};

class ProcessCaptureCounter extends Context.Reference<(() => void) | undefined>(
  "t3/workspace/ProcessCaptureCounter",
  { defaultValue: () => undefined },
) {}

/** Actual file consumers, observed afresh; generic startup does not renew usage clocks. */
export class ProcessPaths extends Context.Reference<Effect.Effect<ReadonlyArray<string> | null>>(
  "t3/workspace/WorktreeProcessPaths",
  {
    defaultValue: Effect.fn("defaultValue")(function* () {
      const platform = yield* HostProcess.Platform;
      const uid = yield* HostProcess.UserId;
      const onAttempt = yield* ProcessCaptureCounter;
      const binary =
        platform === "darwin" && uid !== undefined
          ? yield* yield* ResourceMonitorBinary.ProcessCaptureBinary
          : null;
      return yield* Effect.tryPromise({
        try: () => processPaths(platform, uid, binary, onAttempt),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
    }),
  },
) {}

const identityKey = ({ device, inode }: ObjectIdentity) => `${device}:${inode}`;
type FoundObject = {
  readonly path: string;
  readonly identity: string | null;
  readonly inode: bigint | null;
  readonly socket: boolean;
};
const directoryToken = (stat: Awaited<ReturnType<typeof targetStat>>) =>
  `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
const targetStat = (path: string) => NodeFSP.lstat(path, { bigint: true });

const targetIdentities = async (
  root: string,
  collectIdentities: boolean,
  paths: ReadonlyArray<string>,
  measurement?: InventoryMeasurement,
) => {
  const deadline = performance.now() + 30_000;
  const rootStat = await targetStat(root);
  if (!rootStat.isDirectory() || (await NodeFSP.realpath(root)) !== root)
    throw new Error("Consumer target root is not a canonical directory");
  const directories: Array<{ path: string; token: string }> = [];
  // Socket absence needs complete type/device evidence, not every vnode identity.
  // Paths let a nested root reuse this walk (see scopedEvidence).
  const found: FoundObject[] = [];
  // Keep only possible matches for this exact native capture, rather than
  // retaining every dependency inode for the lifetime of an observation.
  const wantedDevices = collectIdentities ? new Map<bigint, Set<bigint>>() : null;
  const wantedInodes = collectIdentities ? new Set<bigint>() : null;
  if (collectIdentities) {
    for (const object of (paths as CapturedPaths)[nativeIdentities] ?? []) {
      if (object === null || object === "unix-socket") continue;
      if (object.device === null) wantedInodes!.add(object.inode);
      else {
        const inodes = wantedDevices!.get(object.device) ?? new Set<bigint>();
        inodes.add(object.inode);
        wantedDevices!.set(object.device, inodes);
      }
    }
  }
  let objects = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++objects > MAX_TARGET_OBJECTS || depth > 128 || performance.now() > deadline)
      throw new Error("Consumer target inventory limit exceeded");
    if (measurement !== undefined) measurement.objectsVisited++;
    const stat = await targetStat(path);
    if (
      typeof stat.dev !== "bigint" ||
      typeof stat.ino !== "bigint" ||
      stat.ino <= 0n ||
      stat.dev !== rootStat.dev
    )
      throw new Error("Consumer target object identity is unavailable or crosses a device");
    const identity = wantedDevices?.get(stat.dev)?.has(stat.ino)
      ? identityKey({ device: stat.dev, inode: stat.ino })
      : null;
    const inode = wantedInodes?.has(stat.ino) ? stat.ino : null;
    if (identity !== null || inode !== null || stat.isSocket())
      found.push({ path, identity, inode, socket: stat.isSocket() });
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
  return { found, directories, rootToken: directoryToken(rootStat) };
};

type TargetEvidence = Awaited<ReturnType<typeof targetIdentities>>;
type TargetEntry = {
  readonly proof: Promise<TargetEvidence>;
  readonly collectIdentities: boolean;
  unavailable: boolean;
  cause?: unknown;
};
type InventoryMeasurement = ReturnType<typeof emptyStorageCleanupInventoryTrace>;

type CaptureResolutions = {
  readonly sharedPaths: ReadonlyMap<string, { readonly parent: string; token?: string }>;
};

type SweepObservation = {
  readonly captures: WeakMap<ReadonlyArray<string>, CaptureResolutions>;
  readonly resolvedPaths: Set<string>;
  readonly measurement: InventoryMeasurement;
  readonly walkTriggerCounts: Map<string, StorageCleanupWalkTrigger>;
};

export type TargetObservation = {
  readonly targets: WeakMap<ReadonlyArray<string>, Map<string, TargetEntry>>;
  readonly sweep?: SweepObservation;
};

/** Native tree evidence is scoped to the capture that supplied its object identities. */
export const createTargetObservation = (): TargetObservation => ({ targets: new WeakMap() });

export const recordSkippedUsageCheck = (observation?: TargetObservation): void => {
  if (observation?.sweep !== undefined) {
    observation.sweep.measurement.skippedRecentUsageChecks++;
  }
};

export const makeSweepObservation = Effect.fn("WorktreeConsumers.makeSweepObservation")(function* (
  capture: Effect.Effect<ReadonlyArray<string> | null>,
) {
  const measurement = emptyStorageCleanupInventoryTrace();
  const sweep: SweepObservation = {
    captures: new WeakMap(),
    resolvedPaths: new Set(),
    measurement,
    walkTriggerCounts: new Map(),
  };
  const paths = yield* Effect.cached(
    Effect.suspend(() => {
      const start = performance.now();
      return capture.pipe(
        Effect.provideService(ProcessCaptureCounter, () => {
          measurement.processCaptures++;
        }),
        Effect.ensuring(
          Effect.sync(() => {
            measurement.processCaptureMs += performance.now() - start;
          }),
        ),
      );
    }),
  );
  const targets: TargetObservation = { targets: new WeakMap(), sweep };
  return {
    paths,
    targets,
    annotate: Effect.suspend(() => {
      const walkTriggers = [...sweep.walkTriggerCounts.values()]
        .toSorted(
          (left, right) =>
            right.walks - left.walks ||
            left.kind.localeCompare(right.kind) ||
            left.process.localeCompare(right.process),
        )
        .slice(0, MAX_TRACE_WALK_TRIGGERS);
      return Effect.annotateCurrentSpan(STORAGE_CLEANUP_INVENTORY_ATTRIBUTE, {
        ...measurement,
        uniquePaths: sweep.resolvedPaths.size,
        walkTriggers,
      });
    }),
  };
});

const sweepResolutions = (sweep: SweepObservation, paths: readonly string[]) => {
  const previous = sweep.captures.get(paths);
  if (previous !== undefined) return previous;
  const byParent = Map.groupBy(
    [...new Set(paths)].filter(
      (path) => NodePath.isAbsolute(path) && NodePath.resolve(path) === path,
    ),
    NodePath.dirname,
  );
  const sharedPaths = new Map<string, { readonly parent: string; token?: string }>();
  for (const [parent, children] of byParent) {
    // A directory check uses two lookups. Leave sparse directories on the original path.
    if (children.length < 4) continue;
    for (const child of children) sharedPaths.set(child, { parent });
  }
  const capture: CaptureResolutions = { sharedPaths };
  sweep.captures.set(paths, capture);
  return capture;
};

const canonicalParentToken = async (parent: string, measurement: InventoryMeasurement) => {
  const start = performance.now();
  measurement.directoryChecks++;
  try {
    const stat = await targetStat(parent);
    if (
      !stat.isDirectory() ||
      typeof stat.mtimeNs !== "bigint" ||
      typeof stat.ctimeNs !== "bigint" ||
      (await NodeFSP.realpath(parent)) !== parent
    )
      return null;
    return directoryToken(stat);
  } catch {
    return null;
  } finally {
    measurement.directoryCheckMs += performance.now() - start;
  }
};

const cachedPathIsDirect = async (path: string, measurement: InventoryMeasurement) => {
  const start = performance.now();
  measurement.cachedPathChecks++;
  try {
    // Parent timestamps can stay equal when a child is removed or replaced.
    return !(await NodeFSP.lstat(path)).isSymbolicLink();
  } catch {
    return false;
  } finally {
    measurement.cachedPathCheckMs += performance.now() - start;
  }
};

type PathResolution = { readonly path: string } | { readonly error: unknown };

const resolveProcessPath = async (
  path: string,
  sweep?: SweepObservation,
): Promise<PathResolution> => {
  const start = sweep === undefined ? 0 : performance.now();
  if (sweep !== undefined) {
    sweep.measurement.pathResolutions++;
    sweep.resolvedPaths.add(path);
  }
  try {
    return { path: await NodeFSP.realpath(path) };
  } catch (error) {
    return { error };
  } finally {
    if (sweep !== undefined) sweep.measurement.pathResolutionMs += performance.now() - start;
  }
};

const makeProcessPathResolver = (
  paths: readonly string[],
  sweep: SweepObservation,
  reuse = true,
) => {
  const capture = sweepResolutions(sweep, paths);
  const reusedParents = new Map<string, string | null>();
  const checkedParents = new Map<string, string | null>();
  return {
    resolve: async (path: string): Promise<PathResolution> => {
      const entry = capture.sharedPaths.get(path);
      if (entry === undefined) return resolveProcessPath(path, sweep);
      const { parent } = entry;
      const cachedToken = entry.token;
      if (
        reuse &&
        cachedToken !== undefined &&
        (await cachedPathIsDirect(path, sweep.measurement))
      ) {
        const previous = reusedParents.get(parent);
        reusedParents.set(
          parent,
          previous === undefined || previous === cachedToken ? cachedToken : null,
        );
        return { path };
      }
      let token = checkedParents.get(parent);
      if (token === undefined) {
        token = await canonicalParentToken(parent, sweep.measurement);
        checkedParents.set(parent, token);
      }
      const resolution = await resolveProcessPath(path, sweep);
      // Alias chains and failed lookups need fresh resolution. Descriptor identities
      // stay indexed by the original array, even when names repeat.
      if (token !== null && "path" in resolution && resolution.path === path) entry.token = token;
      else delete entry.token;
      return resolution;
    },
    isStillValid: async () => {
      // A later lookup in the same scan can overlap a change to an earlier directory.
      for (const [parent, token] of reusedParents) {
        if (token === null || (await canonicalParentToken(parent, sweep.measurement)) !== token)
          return false;
      }
      return true;
    },
  };
};

const targetUnchanged = async (
  root: string,
  evidence: TargetEvidence,
  measurement?: InventoryMeasurement,
) => {
  const start = performance.now();
  const deadline = start + 30_000;
  if (measurement !== undefined) measurement.targetRevalidations++;
  try {
    for (const directory of evidence.directories) {
      if (performance.now() > deadline)
        throw new Error("Consumer target validation limit exceeded");
      const stat = await targetStat(directory.path);
      if (!stat.isDirectory() || directoryToken(stat) !== directory.token) return false;
    }
    const rootStat = await targetStat(root);
    return (
      rootStat.isDirectory() &&
      directoryToken(rootStat) === evidence.rootToken &&
      (await NodeFSP.realpath(root)) === root
    );
  } catch (cause) {
    if (gone(cause)) return false; // Removed directories require a new complete walk.
    throw cause;
  } finally {
    if (measurement !== undefined) measurement.targetRevalidationMs += performance.now() - start;
  }
};

// A complete no-follow walk of an ancestor visited every object a walk of this
// nested directory would visit, on the same device and within the same limits.
const scopedEvidence = (root: string, evidence: TargetEvidence): TargetEvidence | null => {
  const rootToken = evidence.directories.find((directory) => directory.path === root)?.token;
  if (rootToken === undefined) return null;
  return {
    found: evidence.found.filter((object) => within(root, object.path)),
    directories: evidence.directories.filter((directory) => within(root, directory.path)),
    rootToken,
  };
};

const ancestorEvidence = async (
  root: string,
  collectIdentities: boolean,
  targets: Map<string, TargetEntry>,
  measurement?: InventoryMeasurement,
): Promise<TargetEvidence | null> => {
  for (const [ancestor, entry] of targets) {
    if (
      ancestor === root ||
      !within(ancestor, root) ||
      entry.unavailable ||
      (collectIdentities && !entry.collectIdentities)
    )
      continue;
    try {
      const evidence = scopedEvidence(root, await entry.proof);
      if (evidence !== null && (await targetUnchanged(root, evidence, measurement)))
        return evidence;
    } catch {
      // The ancestor proof failed or cannot be revalidated; walk this root itself.
    }
  }
  return null;
};

const targetEvidence = async (
  root: string,
  paths: ReadonlyArray<string>,
  collectIdentities: boolean,
  observation?: TargetObservation,
  walkTriggers: ReadonlyArray<WalkTrigger> = [],
): Promise<TargetEvidence> => {
  const sweep = observation?.sweep;
  const measurement = sweep?.measurement;
  const walk = (identities: boolean) => {
    if (measurement === undefined) return targetIdentities(root, identities, paths);
    const start = performance.now();
    measurement.treeWalks++;
    for (const trigger of walkTriggers) {
      const key = `${trigger.kind}\0${trigger.process}`;
      const previous = sweep!.walkTriggerCounts.get(key);
      sweep!.walkTriggerCounts.set(key, {
        ...trigger,
        walks: (previous?.walks ?? 0) + 1,
      });
    }
    return targetIdentities(root, identities, paths, measurement).finally(() => {
      measurement.treeWalkMs += performance.now() - start;
    });
  };
  if (observation === undefined) return walk(collectIdentities);
  let targets = observation.targets.get(paths);
  if (!targets) {
    targets = new Map();
    observation.targets.set(paths, targets);
  }
  const collect = (identities: boolean) => {
    const entry: TargetEntry = {
      proof: walk(identities),
      collectIdentities: identities,
      unavailable: false,
    };
    targets.set(root, entry);
    return entry;
  };
  let entry = targets.get(root);
  if (entry === undefined) {
    const derived = await ancestorEvidence(root, collectIdentities, targets, measurement);
    if (derived !== null) return derived;
    entry = targets.get(root);
  }
  const existing = entry !== undefined;
  entry ??= collect(collectIdentities);
  if (entry.unavailable) throw entry.cause;
  try {
    let evidence = await entry.proof;
    if (
      existing &&
      (!(await targetUnchanged(root, evidence, measurement)) ||
        (collectIdentities && !entry.collectIdentities))
    ) {
      // Another concurrent observer may already have replaced this entry.
      entry =
        targets.get(root) === entry
          ? collect(collectIdentities || entry.collectIdentities)
          : targets.get(root)!;
      if (entry.unavailable) throw entry.cause;
      evidence = await entry.proof;
      if (collectIdentities && !entry.collectIdentities)
        return targetEvidence(root, paths, true, observation, walkTriggers);
    }
    return evidence;
  } catch (cause) {
    // An incomplete proof remains unavailable for this capture, without repeated walks.
    entry.unavailable = true;
    entry.cause = cause;
    throw cause;
  }
};

const scanProcessPaths = async (
  canonicalRoot: string,
  paths: ReadonlyArray<string>,
  completeProof: boolean,
  resolvePath: (path: string) => Promise<PathResolution>,
  collectWalkTriggers: boolean,
) => {
  const captured = (paths as CapturedPaths)[nativeIdentities];
  const capturedProcesses = (paths as CapturedPaths)[nativeProcesses];
  const unresolved: ObjectIdentity[] = [];
  const walkTriggers = collectWalkTriggers ? new Map<string, WalkTrigger>() : null;
  const noteWalkTrigger = (kind: WalkTrigger["kind"], index: number) => {
    if (walkTriggers === null) return;
    const process = capturedProcesses?.[index] ?? "unknown";
    const key = `${kind}\0${process}`;
    if (!walkTriggers.has(key)) walkTriggers.set(key, { kind, process });
  };
  // Inventories repeat paths (shared libraries, one entry per descriptor).
  const resolutions = new Map<string, PathResolution>();
  let vanishedSocket = false;
  let matched = false;
  for (const [index, path] of paths.entries()) {
    if (!NodePath.isAbsolute(path)) throw new Error("Process consumer path is not absolute");
    if (within(canonicalRoot, path)) {
      if (!completeProof)
        return {
          matched: true,
          unresolved,
          vanishedSocket,
          walkTriggers: walkTriggers === null ? [] : [...walkTriggers.values()],
        };
      matched = true;
      continue;
    }
    let resolution = resolutions.get(path);
    if (resolution === undefined) {
      resolution = await resolvePath(path);
      resolutions.set(path, resolution);
    }
    try {
      if ("error" in resolution) throw resolution.error;
      if (within(canonicalRoot, resolution.path)) {
        if (!completeProof)
          return {
            matched: true,
            unresolved,
            vanishedSocket,
            walkTriggers: walkTriggers === null ? [] : [...walkTriggers.values()],
          };
        matched = true;
      }
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
        throw new ObjectProofUnavailable("Unresolved process object identity is unavailable", {
          cause: error,
        });
      if (identity === "unix-socket") {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new ObjectProofUnavailable("Unix socket evidence is not a vanished pathname", {
            cause: error,
          });
        vanishedSocket = true;
        noteWalkTrigger("socket", index);
        continue;
      }
      if (identity.device === null && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ObjectProofUnavailable(
          "Device-unknown FIFO evidence is not a vanished pathname",
          {
            cause: error,
          },
        );
      unresolved.push(identity);
      noteWalkTrigger("vnode", index);
    }
  }
  return {
    matched,
    unresolved,
    vanishedSocket,
    walkTriggers: walkTriggers === null ? [] : [...walkTriggers.values()],
  };
};

/**
 * Darwin D/i identify vnodes; only unresolved objects may use complete unchanged no-follow inventories.
 * Socket paths come from sockaddr_un; vanished paths prove absence only for socket-free targets.
 * Callers retain fresh mount protection under the canonical workspace lease.
 */
export const processPathsUseRoot = async (
  canonicalRoot: string,
  paths: ReadonlyArray<string>,
  observation?: TargetObservation,
  completeProof = false,
): Promise<boolean> => {
  if (!NodePath.isAbsolute(canonicalRoot)) throw new Error("Consumer target root is not absolute");
  const sweep = observation?.sweep;
  const scan = (resolvePath: (path: string) => Promise<PathResolution>) =>
    scanProcessPaths(canonicalRoot, paths, completeProof, resolvePath, sweep !== undefined);
  let evidence;
  if (sweep === undefined) {
    evidence = await scan(resolveProcessPath);
  } else {
    const resolver = makeProcessPathResolver(paths, sweep);
    const first = await scan(resolver.resolve).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (!(await resolver.isStillValid())) {
      evidence = await scan(makeProcessPathResolver(paths, sweep, false).resolve);
    } else {
      if ("error" in first) throw first.error;
      evidence = first.value;
    }
  }
  const { matched, unresolved, vanishedSocket, walkTriggers } = evidence;
  if (matched && !completeProof) return true;
  if (unresolved.length === 0 && !vanishedSocket) return matched;
  const { found } = await targetEvidence(
    canonicalRoot,
    paths,
    unresolved.length > 0,
    observation,
    walkTriggers,
  ).catch((cause: unknown) => {
    throw new ObjectProofUnavailable("Consumer target inventory could not be verified", { cause });
  });
  const identities = new Set(found.flatMap((object) => object.identity ?? []));
  const inodes = new Set(found.flatMap((object) => object.inode ?? []));
  return (
    matched ||
    (vanishedSocket && found.some((object) => object.socket)) ||
    unresolved.some((identity) =>
      identity.device === null ? inodes.has(identity.inode) : identities.has(identityKey(identity)),
    )
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

/** Check whether consumer evidence is complete before stopping owned previews. */
export const worktreeConsumerPreflightReason = Effect.fn(
  "WorktreeConsumers.worktreeConsumerPreflightReason",
)(function* (canonicalRoot: string) {
  const paths = yield* yield* ProcessPaths;
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
      // An owned preview may itself be the runtime; the final removal guard
      // checks runtime descriptors again after preview shutdown.
      await processPathsUseRoot(canonicalRoot, paths, undefined, true);
      return null;
    },
    catch: (cause) =>
      cause instanceof ObjectProofUnavailable
        ? "Process object identity or target inventory could not be verified."
        : "Worktree consumer protection could not be verified.",
  }).pipe(Effect.catch((reason) => Effect.succeed(reason)));
});

/** Call under the canonical workspace lease immediately before removing generated files or a checkout. */
export const worktreeConsumerReason = Effect.fn("WorktreeConsumers.worktreeConsumerReason")(
  function* (
    canonicalRoot: string,
    capturedPaths?: ReadonlyArray<string> | null,
    observation?: TargetObservation,
  ) {
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
        if (await processPathsUseRoot(canonicalRoot, paths, observation))
          return "A process is using a file or directory in the worktree.";
        return runtimeKeptReason(canonicalRoot);
      },
      catch: (cause) =>
        cause instanceof ObjectProofUnavailable
          ? "Process object identity or target inventory could not be verified."
          : "Worktree consumer protection could not be verified.",
    }).pipe(Effect.catch((reason) => Effect.succeed(reason)));
  },
);
