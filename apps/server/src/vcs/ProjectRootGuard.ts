import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
default=$(git symbolic-ref -q --short refs/remotes/origin/HEAD) && default=\${default#origin/}
if [ -n "$default" ]; then
  [ "$target" != "refs/heads/$default" ] || exit 0
else
  case "$target" in refs/heads/main | refs/heads/master) exit 0 ;; esac
  default=main
fi
wanted=\${target#refs/heads/}
[ -n "$target" ] || wanted="a detached HEAD"
# Checkout already moved the index and files to the target; carry them back, keeping local edits.
restore=
target_commit=$(git rev-parse -q --verify "\${target:-$next}^{commit}") || target_commit=
if [ -n "$target_commit" ] && [ "$target_commit" != "$(git rev-parse -q --verify HEAD)" ]; then
  git read-tree -m -u "$target_commit" HEAD ||
    restore="Git already changed the files here; put them back with: git read-tree -m -u $target_commit HEAD"
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
    args: ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    allowNonZeroExit: true,
  });
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
  // A linked worktree's project root is not a main checkout; there is nothing to guard.
  if (dirs.exitCode !== 0 || gitDir === undefined || gitDir !== commonDir) return false;

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
        yield* fileSystem.rename(temporaryPath, scriptPath);
      }),
    );
  }

  // A missing script must not abort every ref update, so the command checks for it first.
  const settings = [
    ["command", `[ ! -f ${shellQuote(scriptPath)} ] || exec sh ${shellQuote(scriptPath)}`],
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
