import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Process links, maps, and lstat are native safety boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState, isProcessAlive } from "../serverRuntimeState.ts";
import * as DependencyMounts from "./DependencyMounts.ts";

const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_PATHS = 100_000;
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

const lsofPaths = (output: string): ReadonlyArray<string> | null => {
  if (!output.endsWith("\0\n") || output.includes("\uFFFD")) return null;
  const paths: string[] = [];
  let processes = 0;
  let cwdSeen = false;
  let file: { descriptor: string; type?: string; name?: string } | undefined;
  const finishFile = () => {
    if (!file) return true;
    if (!file.type) return false;
    const name = stripDeleted(file.name ?? "");
    if (name.startsWith("/") && name.includes("\\")) return false;
    if (name.startsWith("/") && !name.includes("\\")) {
      paths.push(name);
      if (file.descriptor === "cwd") cwdSeen = true;
      return paths.length <= MAX_PROCESS_PATHS;
    }
    if (file.descriptor === "cwd" || file.descriptor === "txt") return false;
    return ["IPv4", "IPv6", "unix", "KQUEUE", "PSXSEM", "PSXSHM", "systm"].includes(file.type);
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
      default:
        return null;
    }
  }
  return finishFile() && cwdSeen && processes > 0 ? paths : null;
};

const processPaths = async (platform: NodeJS.Platform, uid: number | undefined) => {
  if (uid === undefined) return null;
  if (platform === "linux") return linuxPaths(uid);
  if (platform !== "darwin") return null;
  return await new Promise<ReadonlyArray<string> | null>((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-a", "-u", String(uid), "-F0pftn", "-n", "-P"],
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
  function* (canonicalRoot: string) {
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
        for (const path of paths) {
          if (!NodePath.isAbsolute(path)) return "Process file-consumer inventory is unavailable.";
          if (within(canonicalRoot, path))
            return "A process is using a file or directory in the worktree.";
          try {
            if (within(canonicalRoot, await NodeFSP.realpath(path)))
              return "A process is using a file or directory in the worktree.";
          } catch (error) {
            if (!gone(error)) throw error;
          }
        }
        return runtimeKeptReason(canonicalRoot);
      },
      catch: () => "Worktree consumer protection could not be verified.",
    }).pipe(Effect.catch((reason) => Effect.succeed(reason)));
  },
);
