// @effect-diagnostics nodeBuiltinImport:off - FileSystem lacks lstat; dependency
// installs contain links, which must be measured and removed without following them.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PersistedServerRuntimeState, isProcessAlive } from "../serverRuntimeState.ts";

const decodeRuntimeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

class GeneratedDependenciesError extends Schema.TaggedError<GeneratedDependenciesError>()(
  "GeneratedDependenciesError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not safely inspect or remove dependencies at '${this.path}'.`;
  }
}

const processWorkingDirectories = async (
  platform: NodeJS.Platform,
  uid: number | undefined,
): Promise<ReadonlyArray<string> | null> => {
  if (uid === undefined) return null;
  if (platform === "linux") {
    const paths: string[] = [];
    for (const name of await NodeFSP.readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if ((await NodeFSP.stat(`/proc/${name}`)).uid !== uid) continue;
        const cwd = (await NodeFSP.readlink(`/proc/${name}/cwd`)).replace(/ \(deleted\)$/, "");
        if (!NodePath.isAbsolute(cwd)) return null;
        paths.push(cwd);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          return null;
      }
    }
    return paths.length > 0 ? paths : null;
  }
  if (platform !== "darwin") return null;
  return await new Promise((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-a", "-u", String(uid), "-d", "cwd", "-F0pn", "-n", "-P"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error || stderr.trim() !== "") return resolve(null);
        const paths: string[] = [];
        let processes = 0;
        for (const field of stdout.split("\0")) {
          const value = field.replace(/^\n/, "");
          if (value.startsWith("p")) processes++;
          if (value.startsWith("n")) {
            if (!NodePath.isAbsolute(value.slice(1))) return resolve(null);
            paths.push(value.slice(1));
          }
        }
        resolve(processes > 0 && paths.length === processes ? paths : null);
      },
    );
  });
};

/** External process inventory can be substituted by isolated service tests. */
export class ProcessWorkingDirectories extends Context.Reference<
  Effect.Effect<ReadonlyArray<string> | null>
>("t3/workspace/ProcessWorkingDirectories", {
  defaultValue: () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const uid = yield* HostProcessUserId;
      return yield* Effect.tryPromise({
        try: () => processWorkingDirectories(platform, uid),
        catch: () => null,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
    }),
}) {}

interface DependencyInput {
  readonly managedWorktreesRoot: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
}

interface DependencyInspection extends DependencyInput {
  readonly repositoryCommonGitDir: string;
  readonly dependencyPath: string;
  readonly packageManager: "npm" | "pnpm";
  /** Allocated bytes excluding multiply linked files (e.g. a shared pnpm store). */
  readonly estimatedReclaimedBytes: number;
  readonly device: number;
  readonly inode: number;
}

export const MAX_DEPENDENCY_REMOVAL_BATCH_SIZE = 4;

export class GeneratedDependencies extends Context.Service<
  GeneratedDependencies,
  {
    readonly processWorkingDirectories: Effect.Effect<ReadonlyArray<string> | null>;
    readonly inspect: (
      input: DependencyInput,
    ) => Effect.Effect<DependencyInspection | null, GeneratedDependenciesError>;
    /** Shares a fresh process check after every entry's Git/identity validation. */
    readonly removeBatch: (
      entries: ReadonlyArray<{
        readonly inspection: DependencyInspection;
        readonly canRemove: Effect.Effect<boolean>;
      }>,
    ) => Effect.Effect<ReadonlyArray<DependencyInspection>>;
  }
>()("t3/workspace/GeneratedDependencies") {}

const inside = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};

const lstatIfPresent = async (target: string) => {
  try {
    return await NodeFSP.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

// Check each component, including ancestors above the managed root. realpath
// alone would accept a symlink whose resolved target happens to be in the tree.
const realDirectoryChain = async (target: string): Promise<boolean> => {
  let current = target;
  while (true) {
    if (!(await lstatIfPresent(current))?.isDirectory()) return false;
    const parent = NodePath.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
};

const hasLiveRuntime = async (worktreePath: string): Promise<boolean> => {
  for (const location of ["userdata", "dev"]) {
    const target = NodePath.join(worktreePath, ".t3", location, "server-runtime.json");
    const stat = await lstatIfPresent(target);
    if (stat === null) continue;
    if (
      !stat.isFile() ||
      stat.size > 64 * 1024 ||
      !(await realDirectoryChain(NodePath.dirname(target)))
    )
      return true;
    try {
      const state = decodeRuntimeState(await NodeFSP.readFile(target, "utf8"));
      // A reused PID only overprotects. Never probe process groups or send a signal.
      if (state.pid <= 0 || isProcessAlive(state.pid)) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const measure = async (root: string): Promise<number | null> => {
  const deadline = performance.now() + 30_000;
  const pending = [{ target: root, depth: 0 }];
  let entries = 1;
  let bytes = 0;
  while (pending.length > 0) {
    if (performance.now() > deadline) return null;
    const batch = pending.splice(-32);
    const results = await Promise.all(
      batch.map(async ({ target, depth }) => {
        if (depth > 64 || performance.now() > deadline) return false;
        const stat = await NodeFSP.lstat(target);
        if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) return false;
        if (stat.isDirectory() || stat.nlink === 1) bytes += stat.blocks * 512;
        if (!Number.isSafeInteger(bytes)) return false;
        if (!stat.isDirectory()) return true;
        if ((await NodeFSP.realpath(target)) !== target) return false;
        const directory = await NodeFSP.opendir(target);
        for await (const entry of directory) {
          if (++entries > 1_000_000 || performance.now() > deadline) return false;
          pending.push({ target: NodePath.join(target, entry.name), depth: depth + 1 });
        }
        return true;
      }),
    );
    if (results.some((result) => !result)) return null;
  }
  return bytes;
};

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const processCwds = yield* ProcessWorkingDirectories;
  const validate = Effect.fn("GeneratedDependencies.validate")(function* (input: DependencyInput) {
    const worktreePath = NodePath.resolve(input.worktreePath);
    const managedWorktreesRoot = NodePath.resolve(input.managedWorktreesRoot);
    const repositoryRoot = NodePath.resolve(input.repositoryRoot);
    const dependencyPath = NodePath.join(worktreePath, "node_modules");
    const io = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (cause) => new GeneratedDependenciesError({ path: dependencyPath, cause }),
      });
    if (!inside(managedWorktreesRoot, worktreePath)) return null;
    const candidate = yield* io(async () => {
      if (!(await realDirectoryChain(dependencyPath))) return null;
      if (!(await lstatIfPresent(NodePath.join(worktreePath, ".git")))?.isFile()) return null;
      if (!(await lstatIfPresent(NodePath.join(worktreePath, "package.json")))?.isFile())
        return null;
      for (const manager of ["pnpm", "npm"] as const) {
        const lock = manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
        const marker = manager === "pnpm" ? ".modules.yaml" : ".package-lock.json";
        if (
          (await lstatIfPresent(NodePath.join(worktreePath, lock)))?.isFile() &&
          (await lstatIfPresent(NodePath.join(dependencyPath, marker)))?.isFile()
        ) {
          return { packageManager: manager, lock };
        }
      }
      return null;
    });
    if (candidate === null) return null;
    const runGit = (args: ReadonlyArray<string>, cwd = worktreePath) =>
      git
        .execute({
          operation: "GeneratedDependencies.inspect",
          cwd,
          args,
          allowNonZeroExit: true,
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) => new GeneratedDependenciesError({ path: dependencyPath, cause }),
          ),
        );
    const location = yield* runGit([
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ]);
    if (location.exitCode !== 0 || location.stdoutTruncated || location.stderrTruncated)
      return null;
    const [top, gitDir, commonDir] = location.stdout.trim().split("\n");
    if (
      !top ||
      !gitDir ||
      !commonDir ||
      NodePath.resolve(top) !== worktreePath ||
      NodePath.resolve(worktreePath, gitDir) === NodePath.resolve(worktreePath, commonDir)
    )
      return null;
    const expectedLocation = yield* runGit(["rev-parse", "--git-common-dir"], repositoryRoot);
    if (
      expectedLocation.exitCode !== 0 ||
      expectedLocation.stdoutTruncated ||
      expectedLocation.stderrTruncated
    )
      return null;
    const expectedCommonDir = expectedLocation.stdout.trim();
    if (expectedCommonDir === "" || expectedCommonDir.includes("\n")) return null;
    const repositoryCommonGitDir = yield* io(async () => {
      const actual = await NodeFSP.realpath(NodePath.resolve(worktreePath, commonDir));
      const expected = await NodeFSP.realpath(NodePath.resolve(repositoryRoot, expectedCommonDir));
      return actual === expected ? actual : null;
    });
    if (repositoryCommonGitDir === null) return null;
    const tracked = yield* runGit([
      "ls-files",
      "-z",
      "--",
      "package.json",
      candidate.lock,
      "node_modules",
    ]);
    if (tracked.exitCode !== 0 || tracked.stdoutTruncated) return null;
    const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
    if (
      !trackedPaths.includes("package.json") ||
      !trackedPaths.includes(candidate.lock) ||
      trackedPaths.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))
    )
      return null;
    const ignored = yield* runGit(["check-ignore", "--quiet", "--", "node_modules/"]);
    if (ignored.exitCode !== 0 || ignored.stdoutTruncated || ignored.stdout !== "") return null;
    const identity = yield* io(async () => {
      const stat = await NodeFSP.lstat(dependencyPath);
      return stat.isDirectory() ? { device: stat.dev, inode: stat.ino } : null;
    });
    return identity === null
      ? null
      : ({
          managedWorktreesRoot,
          repositoryRoot,
          repositoryCommonGitDir,
          worktreePath,
          dependencyPath,
          packageManager: candidate.packageManager,
          ...identity,
        } satisfies Omit<DependencyInspection, "estimatedReclaimedBytes">);
  });

  const inspect = Effect.fn("GeneratedDependencies.inspect")(function* (input: DependencyInput) {
    const current = yield* validate(input);
    if (current === null) return null;
    const estimatedReclaimedBytes = yield* Effect.tryPromise({
      try: async () => {
        const bytes = await measure(current.dependencyPath);
        const after = await NodeFSP.lstat(current.dependencyPath);
        return bytes !== null &&
          after.isDirectory() &&
          after.dev === current.device &&
          after.ino === current.inode
          ? bytes
          : null;
      },
      catch: (cause) => new GeneratedDependenciesError({ path: current.dependencyPath, cause }),
    });
    return estimatedReclaimedBytes === null
      ? null
      : ({ ...current, estimatedReclaimedBytes } satisfies DependencyInspection);
  });

  const skip = (error: GeneratedDependenciesError) =>
    Effect.logDebug("storage cleanup skipped dependency install", { error }).pipe(Effect.as(null));
  const removeBatch = Effect.fn("GeneratedDependencies.removeBatch")(function* (
    entries: ReadonlyArray<{
      readonly inspection: DependencyInspection;
      readonly canRemove: Effect.Effect<boolean>;
    }>,
  ) {
    if (
      entries.length === 0 ||
      entries.length > MAX_DEPENDENCY_REMOVAL_BATCH_SIZE ||
      new Set(entries.map(({ inspection }) => NodePath.resolve(inspection.worktreePath))).size !==
        entries.length
    )
      return [];
    const validated = (yield* Effect.forEach(
      entries,
      ({ inspection, canRemove }) =>
        Effect.gen(function* () {
          const current = yield* validate(inspection);
          if (
            current === null ||
            current.dependencyPath !== inspection.dependencyPath ||
            current.repositoryCommonGitDir !== inspection.repositoryCommonGitDir ||
            current.device !== inspection.device ||
            current.inode !== inspection.inode ||
            current.packageManager !== inspection.packageManager
          )
            return null;
          return { current, inspection, canRemove };
        }).pipe(Effect.catch(skip)),
      { concurrency: entries.length },
    )).filter((entry) => entry !== null);
    if (validated.length === 0) return [];
    // Finish all recognition and Git work before the shared fresh inventory.
    // Leases stay held, and no candidate queues behind another lengthy removal.
    const processes = yield* processCwds;
    if (processes === null) return [];
    const removed = yield* Effect.forEach(
      validated,
      ({ current, inspection, canRemove }) =>
        Effect.gen(function* () {
          if (
            processes.some(
              (cwd) =>
                NodePath.resolve(cwd) === current.worktreePath ||
                inside(current.worktreePath, NodePath.resolve(cwd)),
            ) ||
            !(yield* canRemove)
          )
            return null;
          // Keep the caller's leases until native removal settles on cancellation.
          return yield* Effect.tryPromise({
            try: async () => {
              if (await hasLiveRuntime(current.worktreePath)) return null;
              if (!(await realDirectoryChain(current.dependencyPath))) return null;
              const stat = await NodeFSP.lstat(current.dependencyPath);
              if (stat.dev !== current.device || stat.ino !== current.inode) return null;
              // fs.rm unlinks internal symlinks; it does not traverse their targets.
              await NodeFSP.rm(current.dependencyPath, { recursive: true });
              return { ...current, estimatedReclaimedBytes: inspection.estimatedReclaimedBytes };
            },
            catch: (cause) =>
              new GeneratedDependenciesError({ path: inspection.dependencyPath, cause }),
          }).pipe(Effect.uninterruptible);
        }).pipe(Effect.catch(skip)),
      { concurrency: validated.length },
    );
    return removed.filter((entry) => entry !== null);
  });
  return GeneratedDependencies.of({ inspect, removeBatch, processWorkingDirectories: processCwds });
});

export const layer = Layer.effect(GeneratedDependencies, make);
