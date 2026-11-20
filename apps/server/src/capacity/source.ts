// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem has no statfs/free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { CapacityMeasurements, CapacityMemoryPressure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface CapacitySource {
  readonly read: Effect.Effect<CapacityMeasurements, Error>;
}

export function parsePhysicalCores(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const cores = Number(text.trim());
  return Number.isSafeInteger(cores) && cores > 0 ? cores : null;
}

export function parseLinuxTopology(
  entries: ReadonlyArray<{
    readonly packageId: string;
    readonly coreId: string;
  }>,
): number | null {
  if (entries.length === 0) return null;
  const cores = new Set<string>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.packageId.trim()) || !/^\d+$/.test(entry.coreId.trim())) return null;
    cores.add(`${Number(entry.packageId.trim())}:${Number(entry.coreId.trim())}`);
  }
  return cores.size;
}

export function parseDarwinMemoryPressure(text: string): CapacityMemoryPressure {
  switch (text.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warning";
    case "4":
      return "critical";
    default:
      return "unknown";
  }
}

export function parseDarwinSwapUsed(text: string): number | null {
  const match = /\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\b/i.exec(text);
  if (!match) return null;
  const power = "KMGT".indexOf((match[2] ?? "").toUpperCase()) + 1;
  const bytes = Number(match[1]) * 1024 ** (match[2] ? power : 0);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

export function parseLinuxSwapUsed(text: string): number | null {
  const total = /^SwapTotal:\s*(\d+)\s+kB\s*$/m.exec(text)?.[1];
  const free = /^SwapFree:\s*(\d+)\s+kB\s*$/m.exec(text)?.[1];
  if (total === undefined || free === undefined || Number(free) > Number(total)) return null;
  const bytes = (Number(total) - Number(free)) * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

async function volumeFreeBytes(
  directory: string,
  dirname: (path: string) => string,
): Promise<number | null> {
  try {
    const stat = await NodeFSP.statfs(directory);
    const bytes = stat.bavail * stat.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch (error) {
    // Before the first worktree exists, measure the volume of its nearest existing parent.
    if (isMissing(error) && dirname(directory) !== directory) {
      return volumeFreeBytes(dirname(directory), dirname);
    }
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const nativeSource = Effect.fn("capacity.nativeSource")(function* (worktreesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const sysctl = (name: string) =>
    spawner
      .string(
        ChildProcess.make("/usr/sbin/sysctl", ["-n", name], { stdin: "ignore", stderr: "ignore" }),
      )
      .pipe(Effect.timeout("1 second"));
  const linuxCores = Effect.gen(function* () {
    const cpus = (yield* fs.readDirectory("/sys/devices/system/cpu")).filter((entry) =>
      /^cpu\d+$/.test(entry),
    );
    const entries = yield* Effect.forEach(
      cpus,
      (cpu) => {
        const base = `/sys/devices/system/cpu/${cpu}/topology`;
        return Effect.all({
          packageId: fs.readFileString(`${base}/physical_package_id`),
          coreId: fs.readFileString(`${base}/core_id`),
        });
      },
      { concurrency: 16 },
    );
    return parseLinuxTopology(entries);
  });
  const directoryNames = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (name) =>
            fs
              .lstat(path.join(directory, name))
              .pipe(Effect.map((stat) => ({ name, directory: stat.type === "Directory" }))),
          { concurrency: 16 },
        ),
      ),
      Effect.map((entries) =>
        entries.filter((entry) => entry.directory).map((entry) => entry.name),
      ),
    );
  const folders = directoryNames(worktreesDir).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([] as string[])),
    Effect.flatMap((projects) =>
      Effect.forEach(
        projects,
        (project) =>
          directoryNames(path.join(worktreesDir, project)).pipe(
            Effect.map((entries) => [project, entries.length] as const),
          ),
        { concurrency: 4 },
      ),
    ),
    Effect.map(Object.fromEntries),
    Effect.orElseSucceed(() => null),
  );
  return {
    read: Effect.gen(function* () {
      // Timestamp the beginning: slow or stalled reads never acquire a fresh timestamp on completion.
      const sampledAt = yield* Clock.currentTimeMillis;
      const values = yield* Effect.all(
        {
          physicalCores: (platform === "darwin"
            ? sysctl("hw.physicalcpu").pipe(Effect.map(parsePhysicalCores))
            : platform === "linux"
              ? linuxCores
              : Effect.succeed(null)
          ).pipe(Effect.orElseSucceed(() => null)),
          memoryPressure: (platform === "darwin"
            ? sysctl("kern.memorystatus_vm_pressure_level").pipe(
                Effect.map(parseDarwinMemoryPressure),
              )
            : Effect.succeed("unknown" as const)
          ).pipe(Effect.orElseSucceed(() => "unknown" as const)),
          swapUsedBytes: (platform === "darwin"
            ? sysctl("vm.swapusage").pipe(Effect.map(parseDarwinSwapUsed))
            : platform === "linux"
              ? fs.readFileString("/proc/meminfo").pipe(Effect.map(parseLinuxSwapUsed))
              : Effect.succeed(null)
          ).pipe(Effect.orElseSucceed(() => null)),
          worktreesFreeBytes: Effect.promise(() => volumeFreeBytes(worktreesDir, path.dirname)),
          worktreeFoldersByProject: folders,
        },
        { concurrency: "unbounded" },
      );
      const [load1, load5] = NodeOS.loadavg();
      return {
        sampledAt,
        ...values,
        load1: load1 !== undefined && Number.isFinite(load1) && load1 >= 0 ? load1 : null,
        load5: load5 !== undefined && Number.isFinite(load5) && load5 >= 0 ? load5 : null,
      };
    }),
  } satisfies CapacitySource;
});
