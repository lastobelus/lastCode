import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./GitVcsDriver.ts";

const PROJECT_ROOT_GUARD_HOOK = "lastcode-root-guard";
export const PROJECT_ROOT_GUARD_OVERRIDE_ENV = "LASTCODE_ALLOW_ROOT_BRANCH_CHANGE";

// A non-zero exit in the "prepared" state aborts the ref update. Git holds HEAD.lock
// in this checkout's own git dir only while its HEAD is being rewritten, and the lock
// holds the next value; `git worktree add` from here locks the new worktree's HEAD instead.
const PROJECT_ROOT_GUARD_SCRIPT = `#!/bin/sh
# Installed by LastCode: keeps this project's main checkout on its default branch.
[ "$1" = prepared ] || exit 0
grep ' HEAD$' >/dev/null || exit 0
[ -z "$${PROJECT_ROOT_GUARD_OVERRIDE_ENV}" ] || exit 0
git_dir=$(git rev-parse --path-format=absolute --git-dir) || exit 0
[ "$git_dir" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] || exit 0
next=$(cat "$git_dir/HEAD.lock" 2>/dev/null) || exit 0
for state in rebase-merge rebase-apply BISECT_START; do
  [ ! -e "$git_dir/$state" ] || exit 0
done
case "$next" in
  "ref: "*) target=\${next#ref: } ;;
  *) target= ;;
esac
current=$(git symbolic-ref -q HEAD) || current=
[ "$target" != "$current" ] || exit 0
# Remote-tracking refs, unlike local branches, cannot appear mid-switch. Without one
# there is no upstream to keep this checkout on.
default=$(git symbolic-ref -q refs/remotes/origin/HEAD) && default=\${default#refs/remotes/origin/}
if [ -z "$default" ]; then
  if git show-ref -q --verify refs/remotes/origin/main; then default=main
  elif git show-ref -q --verify refs/remotes/origin/master; then default=master
  else exit 0; fi
fi
[ "$target" != "refs/heads/$default" ] || exit 0
wanted=\${target#refs/heads/}
[ -n "$target" ] || wanted="a detached HEAD"
# Checkout already moved the index and files to the target; carry them back, keeping local
# edits. An unborn (orphan) target starts from the empty tree.
restore=
from=$(git rev-parse -q --verify "\${target:-$next}^{commit}") || from=$(git hash-object -t tree /dev/null)
if [ "$from" != "$(git rev-parse -q --verify HEAD)" ]; then
  git read-tree -m -u "$from" HEAD ||
    restore=" Git had already changed files here toward $wanted; check git status before continuing."
fi
cat >&2 <<EOF
lastcode-root-guard: refused to move $(pwd) to $wanted.$restore
This is a LastCode project's main checkout. It stays on $default so it can auto-pull.
Do branch work in a worktree instead:
  git worktree add <path> -b <branch> origin/$default
  (if Git already created the branch: git worktree add <path> <branch>)
In a LastCode thread, t3_worktree_handoff moves the thread into a new worktree.
To switch here on purpose: ${PROJECT_ROOT_GUARD_OVERRIDE_ENV}=1 git switch <branch>
To turn the guard off for this repository: git config hook.${PROJECT_ROOT_GUARD_HOOK}.enabled false
EOF
exit 1
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Registers the guard as a config-based reference-transaction hook (Git 2.54+), so it
 * runs beside whatever `core.hooksPath` the repository uses. Older Git ignores it.
 * Leaves `hook.lastcode-root-guard.enabled` alone, so a person's opt-out survives.
 */
export const installProjectRootGuard = Effect.fn("ProjectRootGuard.install")(function* (
  cwd: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const dirs = yield* git.execute({
    operation: "ProjectRootGuard.resolveGitDirs",
    cwd,
    args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-prefix"],
    allowNonZeroExit: true,
  });
  const [gitDir, commonDir, prefix] = dirs.stdout.split("\n");
  // Guard only a main checkout's own top level: not a linked worktree, nor a folder
  // that merely sits inside some enclosing repository.
  if (dirs.exitCode !== 0 || gitDir === undefined || gitDir !== commonDir || prefix !== "")
    return false;

  const scriptPath = path.join(commonDir, PROJECT_ROOT_GUARD_HOOK);
  const installed = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (installed !== PROJECT_ROOT_GUARD_SCRIPT) {
    // Git may run the hook at any moment, so never expose a partly written script.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporaryPath = yield* fileSystem.makeTempFileScoped({
          directory: commonDir,
          prefix: `.${PROJECT_ROOT_GUARD_HOOK}.`,
          suffix: ".tmp",
        });
        yield* fileSystem.writeFileString(temporaryPath, PROJECT_ROOT_GUARD_SCRIPT);
        yield* fileSystem.chmod(temporaryPath, 0o644);
        yield* fileSystem.rename(temporaryPath, scriptPath);
      }),
    );
  }

  // A missing or unreadable script must not abort every ref update.
  const settings = [
    ["command", `[ ! -r ${shellQuote(scriptPath)} ] || exec sh ${shellQuote(scriptPath)}`],
    ["event", "reference-transaction"],
  ] as const;
  for (const [field, value] of settings) {
    const key = `hook.${PROJECT_ROOT_GUARD_HOOK}.${field}`;
    const current = yield* git.execute({
      operation: "ProjectRootGuard.readConfig",
      cwd,
      args: ["config", "--local", "--get-all", key],
      allowNonZeroExit: true,
    });
    if (current.exitCode === 0 && current.stdout === `${value}\n`) continue;
    yield* git.execute({
      operation: "ProjectRootGuard.writeConfig",
      cwd,
      args: ["config", "--local", "--replace-all", key, value],
      writesSharedConfig: true,
    });
  }
  return true;
});

/** Guards a project root as it becomes known; failures are logged, never raised. */
export class ProjectRootGuard extends Context.Reference<{
  readonly protect: (workspaceRoot: string) => Effect.Effect<void>;
}>("t3/vcs/ProjectRootGuard", {
  defaultValue: () => ({ protect: () => Effect.void }),
}) {}

export const protectProjectRoot = (workspaceRoot: string) =>
  installProjectRootGuard(workspaceRoot).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to install the project root guard", { workspaceRoot, cause }),
    ),
  );

export const layer = Layer.effect(
  ProjectRootGuard,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
    >();
    return {
      protect: Effect.fn("ProjectRootGuard.protect")(function* (workspaceRoot: string) {
        yield* protectProjectRoot(workspaceRoot).pipe(Effect.provideContext(context));
      }),
    };
  }),
);
