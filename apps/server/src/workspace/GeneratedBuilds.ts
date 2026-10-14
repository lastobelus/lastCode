// @effect-diagnostics nodeBuiltinImport:off -- Canonical lstat boundaries for selective generated-file removal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  generatedBuildActivity,
  inspectGeneratedBuildOwnershipAsync,
  recordGeneratedBuildUse,
  removeGeneratedBuildFilesAsync,
} from "@t3tools/shared/generatedBuildOwnership";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorktreeConsumers from "./WorktreeConsumers.ts";

interface BuildInput {
  readonly managedWorktreesRoot: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
}
interface BuildRemoval {
  readonly bytes: number;
  readonly files: number;
  readonly kept: number;
  readonly reason: string;
  readonly failed: boolean;
}
class GeneratedBuildsError extends Schema.TaggedError<GeneratedBuildsError>()(
  "GeneratedBuildsError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not safely inspect generated build outputs.";
  }
}
export class GeneratedBuilds extends Context.Service<
  GeneratedBuilds,
  {
    readonly hasOutputs: (worktreePath: string) => Effect.Effect<boolean, GeneratedBuildsError>;
    readonly observe: (
      input: BuildInput,
      now: number,
      usedIgnored?: boolean,
      persist?: boolean,
      observationProcessPaths?: Effect.Effect<ReadonlyArray<string> | null>,
    ) => Effect.Effect<{ lastUsedAt: number; renewed: boolean } | null, GeneratedBuildsError>;
    readonly remove: <EligibilityError>(
      input: BuildInput,
      now: number,
      days: number,
      archived: boolean,
      canRemove: Effect.Effect<boolean, EligibilityError>,
      isStillEligible: Effect.Effect<boolean, EligibilityError>,
    ) => Effect.Effect<BuildRemoval>;
  }
>()("t3/workspace/GeneratedBuilds") {}

const inside = (root: string, target: string, allowEqual = false) => {
  const relative = NodePath.relative(root, target);
  return (
    (allowEqual || relative !== "") &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
};
const lstat = async (target: string) => {
  try {
    return await NodeFSP.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const realDirectoryChain = async (target: string) => {
  let current = target;
  while (true) {
    if (!(await lstat(current))?.isDirectory()) return false;
    const parent = NodePath.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
};
const discover = async (cwd: string) => {
  const roots: string[] = [];
  const apps = NodePath.join(cwd, "apps");
  const appStat = await lstat(apps);
  if (appStat && !appStat.isDirectory())
    throw new Error("Application build roots cannot be safely discovered");
  if (appStat) {
    const entries = await NodeFSP.readdir(apps, { withFileTypes: true });
    if (entries.length > 128) throw new Error("Application build-root inventory exceeds its bound");
    for (const entry of entries) {
      const root = `apps/${entry.name}/dist`;
      // Never descend a linked app parent, even for discovery.
      if (entry.isDirectory() && (await lstat(NodePath.join(cwd, root)))) roots.push(root);
      else if (entry.isSymbolicLink())
        throw new Error("Application build roots contain a linked parent");
    }
  }
  const native = "native/resource-monitor/target/debug";
  let directory = cwd;
  for (const component of native.split("/").slice(0, -1)) {
    directory = NodePath.join(directory, component);
    const stat = await lstat(directory);
    if (!stat) return roots;
    if (!stat.isDirectory()) throw new Error("Native build roots contain an unsafe parent");
  }
  if (await lstat(NodePath.join(cwd, native))) roots.push(native);
  return roots;
};

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const io = <A>(path: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => new GeneratedBuildsError({ path, cause }),
    });
  const runGit = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    git
      .execute({
        operation: "GeneratedBuilds.recognize",
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: 1024 * 1024,
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(Effect.mapError((cause) => new GeneratedBuildsError({ path: cwd, cause })));
  const complete = (result: GitVcsDriver.ExecuteGitResult) =>
    !result.stdoutTruncated && !result.stderrTruncated;
  const validate = Effect.fn("GeneratedBuilds.validate")(function* (
    input: BuildInput,
    root: string,
  ) {
    const cwd = NodePath.resolve(input.worktreePath);
    const managed = NodePath.resolve(input.managedWorktreesRoot);
    const output = NodePath.join(cwd, root);
    if (
      !inside(managed, cwd) ||
      (!/^apps\/[a-zA-Z0-9_-]+\/dist$/.test(root) &&
        root !== "native/resource-monitor/target/debug")
    )
      return false;
    if (
      !(yield* io(
        output,
        async () =>
          (await realDirectoryChain(output)) &&
          (await lstat(NodePath.join(cwd, ".git")))?.isFile() === true,
      ))
    )
      return false;
    const location = yield* runGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]);
    if (!complete(location) || location.exitCode !== 0) return false;
    const [top, gitDir, common] = location.stdout.trim().split("\n");
    if (
      !top ||
      !gitDir ||
      !common ||
      NodePath.resolve(top) !== cwd ||
      NodePath.resolve(gitDir) === NodePath.resolve(common)
    )
      return false;
    const expected = yield* runGit(input.repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      !complete(expected) ||
      expected.exitCode !== 0 ||
      expected.stdout.trim() === "" ||
      expected.stdout.trim().includes("\n")
    )
      return false;
    if (
      !(yield* io(
        output,
        async () =>
          (await NodeFSP.realpath(common)) === (await NodeFSP.realpath(expected.stdout.trim())),
      ))
    )
      return false;
    const registered = yield* runGit(input.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (
      !complete(registered) ||
      registered.exitCode !== 0 ||
      !registered.stdout.split("\0").includes(`worktree ${cwd}`)
    )
      return false;
    const native = root === "native/resource-monitor/target/debug";
    const sourceRoot = native ? "native/resource-monitor" : root.slice(0, -5);
    const required = native
      ? [`${sourceRoot}/Cargo.toml`, `${sourceRoot}/Cargo.lock`]
      : [`${sourceRoot}/package.json`];
    const configs = native
      ? []
      : ["ts", "js", "mts", "mjs"].map((extension) => `${sourceRoot}/vite.config.${extension}`);
    const tracked = yield* runGit(cwd, ["ls-files", "-z", "--", ...required, ...configs, root]);
    if (!complete(tracked) || tracked.exitCode !== 0) return false;
    const names = tracked.stdout.split("\0").filter(Boolean);
    if (
      required.some((file) => !names.includes(file)) ||
      (!native && !configs.some((file) => names.includes(file))) ||
      names.some((file) => file === root || file.startsWith(`${root}/`))
    )
      return false;
    const regular = yield* io(output, async () => {
      for (const file of [...required, ...configs.filter((file) => names.includes(file))])
        if (!(await lstat(NodePath.join(cwd, file)))?.isFile()) return false;
      return true;
    });
    if (!regular) return false;
    const ignored = yield* runGit(cwd, ["check-ignore", "--quiet", "--", `${root}/`]);
    return complete(ignored) && ignored.exitCode === 0;
  });
  const ignoredFiles = Effect.fn("GeneratedBuilds.ignoredFiles")(function* (
    cwd: string,
    root: string,
    paths: readonly string[],
  ) {
    if (paths.length === 0) return new Set<string>();
    const result = yield* runGit(
      cwd,
      ["check-ignore", "-z", "--stdin"],
      paths.map((path) => `${root}/${path}\0`).join(""),
    );
    if (!complete(result) || ![0, 1].includes(result.exitCode)) return new Set<string>();
    return new Set(
      result.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => path.slice(root.length + 1)),
    );
  });
  const actualOutputUse = (cwd: string, root: string, paths: readonly string[] | null) =>
    io(cwd, async () => {
      if (paths === null) return false;
      return WorktreeConsumers.processPathsUseRoot(NodePath.join(cwd, root), paths);
    });
  const activity = (cwd: string, root: string) =>
    Effect.try({
      try: () => generatedBuildActivity(cwd, root),
      catch: (cause) => new GeneratedBuildsError({ path: cwd, cause }),
    });
  const hasOutputs = (cwd: string) =>
    io(cwd, () => discover(cwd)).pipe(Effect.map((roots) => roots.length > 0));
  const observe = Effect.fn("GeneratedBuilds.observe")(function* (
    input: BuildInput,
    now: number,
    _usedIgnored = false,
    persist = true,
    observationProcessPaths?: Effect.Effect<ReadonlyArray<string> | null>,
  ) {
    const roots = yield* io(input.worktreePath, () => discover(input.worktreePath));
    let paths: ReadonlyArray<string> | null | undefined;
    let oldest: number | null = null;
    let renewed = false;
    for (const root of roots) {
      if (!(yield* validate(input, root))) continue;
      let clock = yield* activity(input.worktreePath, root);
      if (!clock) continue;
      const output = NodePath.join(input.worktreePath, root);
      // Read-only revalidation reads the durable token/clock. Writing observation
      // shares the sweep snapshot, while removal guards still capture fresh evidence.
      if (persist && paths === undefined) {
        const capture = observationProcessPaths ?? (yield* WorktreeConsumers.ProcessPaths);
        paths = yield* capture;
      }
      if (persist && paths === null) return null;
      const used = persist && (yield* actualOutputUse(input.worktreePath, root, paths ?? null));
      if (used && persist) {
        yield* Effect.try({
          try: () => recordGeneratedBuildUse(input.worktreePath, root, now),
          catch: (cause) => new GeneratedBuildsError({ path: output, cause }),
        });
        clock = yield* activity(input.worktreePath, root);
        renewed = true;
      }
      if (clock) oldest = Math.min(oldest ?? clock.lastUsedAt, clock.lastUsedAt);
    }
    return oldest === null ? null : { lastUsedAt: oldest, renewed };
  });
  const remove = Effect.fn("GeneratedBuilds.remove")(function* <EligibilityError>(
    input: BuildInput,
    now: number,
    days: number,
    archived: boolean,
    canRemove: Effect.Effect<boolean, EligibilityError>,
    isStillEligible: Effect.Effect<boolean, EligibilityError>,
  ) {
    const result = { bytes: 0, files: 0, kept: 0, reason: "", failed: false };
    const reasons = new Set<string>();
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const guard = Effect.fn("GeneratedBuilds.guard")(function* (
      root: string,
      paths: readonly string[],
    ) {
      let failureReason = "Build cleanup workspace ownership check failed; files were retained.";
      return yield* Effect.gen(function* () {
        if (!(yield* canRemove)) {
          reasons.add("Current workspace ownership or policy protects build files.");
          return false;
        }
        failureReason = "Build cleanup process inventory check failed; files were retained.";
        const processes = yield* yield* WorktreeConsumers.ProcessPaths;
        if (processes === null) {
          reasons.add("Process file-consumer inventory is unavailable; build files were retained.");
          return false;
        }
        failureReason = "Build cleanup output-consumer identity check failed; files were retained.";
        if (yield* actualOutputUse(input.worktreePath, root, processes)) {
          failureReason = "Build cleanup usage renewal check failed; files were retained.";
          yield* Effect.try({
            try: () => recordGeneratedBuildUse(input.worktreePath, root, now),
            catch: (cause) => new GeneratedBuildsError({ path: input.worktreePath, cause }),
          });
        }
        failureReason = "Build cleanup worktree consumer check failed; files were retained.";
        const consumerReason = yield* WorktreeConsumers.worktreeConsumerReason(
          input.worktreePath,
          processes,
        );
        if (consumerReason !== null) {
          reasons.add(`Build files were retained: ${consumerReason}`);
          return false;
        }
        // File-specific Git recognition follows the potentially slower OS inventory.
        failureReason =
          "Build cleanup Git and generated-path validation check failed; files were retained.";
        if (!(yield* validate(input, root))) {
          reasons.add("Git or generated-path eligibility changed before build removal.");
          return false;
        }
        failureReason = "Build cleanup Git-ignore verification check failed; files were retained.";
        const ignored = yield* ignoredFiles(input.worktreePath, root, paths);
        if (paths.some((path) => !ignored.has(path))) {
          reasons.add("Git-ignore eligibility changed before build removal.");
          return false;
        }
        failureReason = "Build cleanup final eligibility check failed; files were retained.";
        if (!(yield* isStillEligible)) {
          reasons.add("Build cleanup policy or ownership changed before removal.");
          return false;
        }
        return true;
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            result.failed = true;
            reasons.add(failureReason);
            return false;
          }),
        ),
      );
    });
    const operation = Effect.gen(function* () {
      if (!Number.isFinite(days) || days <= 0 || !Number.isSafeInteger(now) || now < 0) {
        reasons.add("Build cleanup policy is disabled or invalid.");
        return;
      }
      const roots = yield* io(input.worktreePath, () => discover(input.worktreePath));
      for (const root of roots) {
        if (!(yield* validate(input, root))) {
          result.kept++;
          reasons.add("Build root is not a recognized untracked ignored output.");
          continue;
        }
        const clock = yield* activity(input.worktreePath, root);
        if (!clock) {
          result.kept++;
          reasons.add("Legacy build output needs exact-file review.");
          continue;
        }
        if (!archived && clock.lastUsedAt >= now - days * 86_400_000) {
          result.kept++;
          reasons.add("Build output is within the delay configured in settings.");
          continue;
        }
        const inspected = yield* io(input.worktreePath, () =>
          inspectGeneratedBuildOwnershipAsync(input.worktreePath, root),
        );
        if (!inspected || inspected.token !== clock.token) {
          result.kept++;
          reasons.add("Build provenance changed during inspection.");
          continue;
        }
        const valid = inspected.files
          .filter((file) => file.reason === null)
          .map((file) => file.path);
        result.kept += inspected.files.length - valid.length;
        if (valid.length !== inspected.files.length)
          reasons.add("Modified, missing or unsafe emitted files were retained.");
        const ignored = yield* ignoredFiles(input.worktreePath, root, valid);
        const selected = valid.filter((path) => ignored.has(path));
        result.kept += valid.length - selected.length;
        if (selected.length !== valid.length)
          reasons.add("Nonignored emitted files were retained.");
        if (selected.length === 0) continue;
        const removed = yield* Effect.tryPromise({
          try: (signal) =>
            removeGeneratedBuildFilesAsync(
              input.worktreePath,
              root,
              inspected.token,
              selected,
              (paths) =>
                runPromise(
                  guard(root, paths).pipe(
                    Effect.catch(() =>
                      Effect.sync(() => {
                        result.failed = true;
                        reasons.add("Build cleanup eligibility check failed; files were retained.");
                        return false;
                      }),
                    ),
                  ),
                  {
                    signal,
                  },
                )
                  .then((eligible) => eligible && !signal.aborted)
                  .catch(() => {
                    result.failed = true;
                    reasons.add("Build cleanup protection failed; files were retained.");
                    return false;
                  }),
              signal,
            ),
          catch: (cause) => new GeneratedBuildsError({ path: input.worktreePath, cause }),
        });
        result.bytes += removed.bytes;
        result.files += removed.files;
        result.kept += removed.kept.length;
        for (const file of removed.kept) reasons.add(file.reason);
        const residual = yield* io(input.worktreePath, async () => {
          const output = NodePath.join(input.worktreePath, root);
          const stat = await lstat(output);
          return (
            stat !== null && (!stat.isDirectory() || (await NodeFSP.readdir(output)).length > 0)
          );
        });
        if (residual) {
          result.kept++;
          reasons.add("Unowned or retained additions remain in the build root.");
        }
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          result.failed = true;
          result.kept++;
          reasons.add("Build cleanup protection could not be verified.");
        }),
      ),
    );
    yield* operation;
    const removedReason =
      result.files > 0
        ? "Removed unchanged compiler-emitted files; recovered size is an estimate."
        : "";
    result.reason =
      [removedReason, ...reasons].filter(Boolean).join(" ") ||
      "No verified emitted files were eligible.";
    return result;
  });
  return { hasOutputs, observe, remove };
});
export const layer = Layer.effect(GeneratedBuilds, make);
