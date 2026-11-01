// @effect-diagnostics nodeBuiltinImport:off -- Disposable Git fixtures drive checkpoint subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assertSupportedNodeVersion } from "./lastcode-local-ci.ts";

const NIGHTLY_A = "v9.9.9-nightly.20990101.1";
const NIGHTLY_B = "v9.9.9-nightly.20990102.2";
const NIGHTLY_C = "v9.9.9-nightly.20990103.3";
const NIGHTLY_D = "v9.9.9-nightly.20990104.4";
const NIGHTLY_E = "v9.9.9-nightly.20990105.5";

interface Fixture {
  readonly home: string;
  readonly origin: string;
  readonly repo: string;
  readonly root: string;
  readonly taskRoot: string;
  readonly upstream: string;
}

// The synthetic repositories need the runners' shared runtime imports too.
const FIXTURE_RUNTIME_PATHS = [
  ".gitignore",
  "package.json",
  "apps/web/src/components/branding/LastCodeWordmark.tsx",
  "packages/shared/src/desktopDistribution.ts",
  "packages/shared/src/dependencyActivity.ts",
  "packages/shared/src/generatedBuildOwnership.ts",
  "packages/shared/src/nativeFileSystem.ts",
  "scripts/lastcode-local-ci.ts",
  "scripts/lib/lastcode-action-kit.ts",
  "scripts/lib/lastcode-ci-admission-lock.ts",
  "scripts/lib/lastcode-ci-budget.ts",
  "scripts/lib/lastcode-ci-collection.ts",
  "scripts/lib/lastcode-ci-diagnostics.ts",
  "scripts/lib/lastcode-ci-process.ts",
  "scripts/lib/lastcode-ci-process-identity.ts",
  "scripts/lib/lastcode-ci-scope.ts",
  "scripts/lib/lastcode-ci-worker.mjs",
  "scripts/lastcode-carry-checkpoint.ts",
  "scripts/lastcode-carry-replay.ts",
  "scripts/lastcode-carry-set.json",
  "scripts/lastcode-carry-set.ts",
  "scripts/lastcode-checkpoint-history.ts",
  "scripts/lastcode-checkpoint.ts",
  "scripts/lastcode-quiet-references.ts",
  "scripts/lastcode-migration-history.ts",
  "scripts/lastcode-migration-validation.ts",
  "scripts/lastcode-lock.mjs",
  "scripts/lastcode-main-write-lock.ts",
  "scripts/lastcode-build-mac.ts",
  "scripts/lastcode-nightly.ts",
  "scripts/lib/lastcode-installable-tag.ts",
] as const;

function git(repo: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  }).trim();
}

function gitResult(
  repo: string,
  args: ReadonlyArray<string>,
): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(repo: string, path: string, contents: string): void {
  const target = NodePath.join(repo, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, contents);
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", subject, ...(body ? ["-m", body] : [])]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function commitTree(repo: string, tree: string, parent: string, message: string): string {
  return git(repo, ["commit-tree", tree, "-p", parent, "-F", "-"], message);
}

function fakeVp(path: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = install ] && [ -f "$FIXTURE_CI_FAILURES/install" ]; then echo 'fixture dependency installation failure'; exit 75; fi
if [ "$1" = install ]; then
  mkdir -p node_modules/.bin
  if [ ! -f node_modules/.bin/vp ]; then cp "$0" node_modules/.bin/vp; fi
fi
if [ "$1" = test ] && [ "$3" = apps/server/src/persistence/DatabaseMigrations.test.ts ] && [ "$FIXTURE_FAIL_MIGRATIONS" = 1 ]; then exit 79; fi
if [ "$1" = install ] && [ -n "$FIXTURE_VALIDATED_HEAD" ]; then git rev-parse HEAD > "$FIXTURE_VALIDATED_HEAD"; fi
if [ "$1" = install ] && [ "$FIXTURE_MERGE_PHASE" = smoke ] && [ -n "$FIXTURE_MERGE_COMMIT" ] && [ ! -f "$FIXTURE_MERGE_MARKER" ]; then
  git --git-dir="$FIXTURE_ORIGIN" update-ref refs/heads/lastcode/main "$FIXTURE_MERGE_COMMIT" "$FIXTURE_SOURCE" || exit 1
  touch "$FIXTURE_MERGE_MARKER"
fi
if [ "$1" = install ] && [ -n "$FIXTURE_MOVED_NIGHTLY" ]; then
  if [ -n "$FIXTURE_MOVED_UPSTREAM_REMOTE" ]; then
    git --git-dir="$FIXTURE_MOVED_UPSTREAM_REMOTE" update-ref "refs/tags/$FIXTURE_MOVED_NIGHTLY" "$FIXTURE_NEW_UPSTREAM" || exit 1
  else
    git update-ref "refs/tags/$FIXTURE_MOVED_NIGHTLY" "$FIXTURE_NEW_UPSTREAM" || exit 1
  fi
fi
if [ -n "$FIXTURE_UNPUBLISHED_TAG" ] && git show-ref --verify --quiet "refs/tags/$FIXTURE_UNPUBLISHED_TAG"; then echo 'candidate tag was published before validation'; exit 74; fi
if [ -n "$FIXTURE_CI_EVENTS" ]; then printf 'vp %s\\n' "$*" >> "$FIXTURE_CI_EVENTS"; fi
if [ "$1" = check ] && [ -f "$FIXTURE_CI_FAILURES/lint" ]; then echo 'fixture lint failure'; exit 71; fi
if [ "$1" = run ] && [ "$2" = -r ] && [ "$5" = typecheck ] && [ -f "$FIXTURE_CI_FAILURES/typecheck" ]; then echo 'fixture smoke typecheck failure'; exit 72; fi
if [ "$1" = run ] && [ "$2" = --filter ] && [ "$3" = @fixture/early ] && [ "$7" = typecheck ] && [ -f "$FIXTURE_CI_FAILURES/typecheck" ]; then echo 'fixture early typecheck failure'; exit 72; fi
if [ "$1" = run ] && [ "$2" = --filter ] && [ "$3" = @fixture/later ] && [ "$7" = test ] && [ -f "$FIXTURE_CI_FAILURES/test" ]; then echo 'fixture later test failure'; exit 73; fi
if [ "$1" = run ] && [ "$2" = build:desktop ]; then
  mkdir -p apps/desktop/dist-electron
  echo 'desktopBridge getLocalEnvironmentBootstraps PICK_FOLDER_CHANNEL __clerk_internal_electron_passkeys' > apps/desktop/dist-electron/preload.cjs
fi
exit 0
`,
    { mode: 0o755 },
  );
}

function installFixtureRuntime(fixture: Fixture): void {
  NodeFS.mkdirSync(NodePath.join(fixture.repo, "scripts"), { recursive: true });
  NodeFS.symlinkSync(
    NodePath.join(fixture.taskRoot, "scripts", "node_modules"),
    NodePath.join(fixture.repo, "scripts", "node_modules"),
    "dir",
  );
  fakeVp(NodePath.join(fixture.repo, "node_modules", ".bin", "vp"));
  const fakeBin = NodePath.join(fixture.root, "bin");
  write(fakeBin, "osascript", "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(NodePath.join(fakeBin, "osascript"), 0o755);
  for (const command of ["cargo", "brew"]) {
    write(
      fakeBin,
      command,
      `#!/bin/sh
if [ -n "$FIXTURE_CI_EVENTS" ]; then printf '${command} %s\\n' "$*" >> "$FIXTURE_CI_EVENTS"; fi
if [ -n "$CARGO_TARGET_DIR" ]; then mkdir -p "$CARGO_TARGET_DIR/debug"; fi
exit 0
`,
    );
    NodeFS.chmodSync(NodePath.join(fakeBin, command), 0o755);
  }
  write(fakeBin, "rustup", "#!/bin/sh\ncommand -v cargo\n");
  NodeFS.chmodSync(NodePath.join(fakeBin, "rustup"), 0o755);
}

function initFixture(): Fixture {
  const taskRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-carry-lifecycle-"));
  const repo = NodePath.join(root, "repository");
  const origin = NodePath.join(root, "origin.git");
  const upstream = NodePath.join(root, "upstream.git");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home);
  // These subprocesses share CI workers; background priority can starve them on Linux.
  write(
    home,
    "ci-settings.json",
    JSON.stringify({ lastcodeLocalCi: { backgroundPriority: false } }),
  );
  NodeFS.mkdirSync(repo);
  git(repo, ["init", "--quiet", "--initial-branch=fixture"]);
  for (const path of FIXTURE_RUNTIME_PATHS) {
    const target = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(taskRoot, path), target);
  }
  write(repo, "pnpm-workspace.yaml", "packages:\n  - fixtures/*\n");
  for (const name of ["early", "later"]) {
    write(
      repo,
      `fixtures/${name}/package.json`,
      `${JSON.stringify({ name: `@fixture/${name}`, scripts: { typecheck: "fixture", test: "fixture" } })}\n`,
    );
  }
  write(
    repo,
    "scripts/release-smoke.ts",
    'import * as fs from "node:fs";\nif (process.env.FIXTURE_CI_EVENTS) fs.appendFileSync(process.env.FIXTURE_CI_EVENTS, "release-smoke\\n");\n',
  );
  const persistence = "apps/server/src/persistence";
  write(
    repo,
    `${persistence}/Migrations.ts`,
    'import initial from "./Migrations/001_Initial.ts";\nexport const migrationEntries = [[1, "Initial", initial]] as const;\n',
  );
  write(repo, `${persistence}/Migrations/001_Initial.ts`, 'export default "upstream migration";\n');
  write(
    repo,
    `${persistence}/LastCodeMigrations.ts`,
    'import initial from "./LastCodeMigrations/001_Initial.ts";\nexport const lastcodeMigrationEntries = [[1, "Initial", initial]] as const;\n',
  );
  write(
    repo,
    `${persistence}/LastCodeMigrations/001_Initial.ts`,
    'export default "LastCode migration";\n',
  );
  write(
    repo,
    `${persistence}/LegacyMigrationHistories.ts`,
    'export const legacyMigrationHistories = [{ source: "fixture-release", entries: [[1, "Initial"]] }] as const;\n',
  );
  write(repo, `${persistence}/DatabaseMigrations.ts`, "export {};\n");
  write(repo, `${persistence}/DatabaseMigrations.test.ts`, "export {};\n");
  NodeFS.appendFileSync(
    NodePath.join(repo, ".git", "config"),
    "\n[user]\n\tname = Carry lifecycle test\n\temail = carry-lifecycle@localhost\n[core]\n\thooksPath = /dev/null\n",
  );
  git(root, ["init", "--quiet", "--bare", origin]);
  git(root, ["init", "--quiet", "--bare", upstream]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["remote", "add", "upstream", upstream]);
  installFixtureRuntime({ home, origin, repo, root, taskRoot, upstream });
  return { home, origin, repo, root, taskRoot, upstream };
}

function checkpoint(
  fixture: Fixture,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
): NodeChildProcess.SpawnSyncReturns<string> {
  const fakeBin = NodePath.join(fixture.root, "bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    T3CODE_HOME: fixture.home,
    T3CODE_LOCAL_CI_SETTINGS_PATH: NodePath.join(fixture.home, "ci-settings.json"),
    ...environment,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };
  // Fixture reports must not satisfy the enclosing Project Action.
  delete env.T3CODE_ACTION_RUN_ID;
  delete env.T3CODE_ACTION_EVENT_TOKEN;
  const candidates = [
    process.execPath,
    ...(process.env.PATH?.split(NodePath.delimiter).map((directory) =>
      NodePath.join(directory, "node"),
    ) ?? []),
  ];
  const node = [...new Set(candidates)].find((candidate) => {
    if (!NodeFS.existsSync(candidate)) return false;
    try {
      if (candidate === process.execPath) {
        assertSupportedNodeVersion();
        return true;
      }
      const version = NodeChildProcess.spawnSync(candidate, ["-p", "process.versions.node"], {
        encoding: "utf8",
      });
      if (version.status !== 0) return false;
      assertSupportedNodeVersion(version.stdout.trim());
      return true;
    } catch {
      return false;
    }
  });
  if (!node) throw new Error("Checkpoint fixture requires the supported project Node on PATH.");
  return NodeChildProcess.spawnSync(node, ["scripts/lastcode-checkpoint.ts", ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env,
  });
}

function checkout(repo: string, branch: string, ref: string): void {
  git(repo, ["checkout", "--quiet", "-B", branch, ref]);
}

function annotatedCheckpoint(
  fixture: Fixture,
  nightly: string,
  commit: string,
  sourceCommit: string,
): string {
  const tag = `lastcode/checkpoint/${nightly}`;
  git(fixture.repo, [
    "tag",
    "--annotate",
    tag,
    commit,
    "--message",
    [
      `LastCode checkpoint for ${nightly}`,
      "",
      `Upstream-Tag: ${nightly}`,
      `Upstream-Commit: ${git(fixture.repo, ["rev-parse", `${nightly}^{commit}`])}`,
      `LastCode-Commit: ${commit}`,
      "Source-Ref: refs/remotes/origin/lastcode/main",
      `Source-Commit: ${sourceCommit}`,
      "Created-At: 2099-01-02T00:00:00.000Z",
    ].join("\n"),
  ]);
  git(fixture.repo, ["push", "--quiet", "origin", tag]);
  return tag;
}

function remoteCommit(remote: string, ref: string): string {
  return git(remote, ["rev-parse", `${ref}^{commit}`]);
}

function remoteMissing(remote: string, ref: string): boolean {
  return gitResult(remote, ["rev-parse", "--verify", ref]).status !== 0;
}

function recoveryWorktree(repo: string): string {
  return NodePath.join(
    NodePath.dirname(repo),
    `${NodePath.basename(repo)}-worktrees`,
    "lastcode-nightly-sync",
  );
}

function historicalFixture(conflict = false, sourceMessage?: string) {
  const fixture = initFixture();
  const { repo } = fixture;
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repo, "scripts/lastcode-carry-set.json"), "utf8"),
  ) as Record<string, unknown>;
  delete manifest.replay;
  write(repo, "scripts/lastcode-carry-set.json", `${JSON.stringify(manifest)}\n`);
  git(repo, ["add", "--force", "node_modules/.bin/vp"]);
  const base = commit(repo, "fixture upstream base");
  git(repo, ["tag", NIGHTLY_A, base]);
  write(repo, "downstream.txt", "downstream behavior\n");
  const source = commit(repo, "downstream source", sourceMessage);
  git(repo, ["push", "--quiet", "origin", `${source}:refs/heads/lastcode/main`]);
  annotatedCheckpoint(fixture, NIGHTLY_A, source, source);
  checkout(repo, "upstream-main", base);
  write(repo, conflict ? "downstream.txt" : "upstream.txt", "upstream behavior\n");
  const upstream = commit(repo, "new upstream nightly");
  git(repo, ["tag", NIGHTLY_B, upstream]);
  git(repo, ["push", "--quiet", "upstream", `HEAD:refs/heads/main`, NIGHTLY_A, NIGHTLY_B]);
  checkout(repo, "lastcode-source", source);
  write(repo, "merged-during-checkpoint.txt", "concurrent merge must survive\n");
  const merged = commit(repo, "concurrent feature merge", sourceMessage);
  git(repo, ["push", "--quiet", "origin", `${merged}:refs/heads/fixture-merge`]);
  checkout(repo, "lastcode-source", source);
  NodeFS.writeFileSync(
    NodePath.join(fixture.origin, "hooks", "pre-receive"),
    `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/lastcode/main ] && [ "$FIXTURE_MERGE_PHASE" = push ] && [ ! -f "$FIXTURE_MERGE_MARKER" ]; then
    env -u GIT_QUARANTINE_PATH git update-ref refs/heads/lastcode/main "$FIXTURE_MERGE_COMMIT" "$FIXTURE_SOURCE" || exit 1
    touch "$FIXTURE_MERGE_MARKER"
  fi
done
`,
    { mode: 0o755 },
  );
  const queryMarker = NodePath.join(fixture.root, "pr-query");
  NodeFS.writeFileSync(
    NodePath.join(fixture.root, "bin", "gh"),
    `#!/bin/sh\ntouch "$FIXTURE_PR_QUERY"\necho '[{"number":209}]'\nexit 1\n`,
    { mode: 0o755 },
  );
  return {
    fixture,
    source,
    merged,
    queryMarker,
    environment: { FIXTURE_PR_QUERY: queryMarker },
    raceEnvironment: {
      FIXTURE_PR_QUERY: queryMarker,
      FIXTURE_ORIGIN: fixture.origin,
      FIXTURE_SOURCE: source,
      FIXTURE_MERGE_COMMIT: merged,
      FIXTURE_MERGE_MARKER: NodePath.join(fixture.root, "merged"),
    },
  };
}

export {
  NIGHTLY_A,
  NIGHTLY_B,
  NIGHTLY_C,
  NIGHTLY_D,
  NIGHTLY_E,
  git,
  gitResult,
  write,
  commit,
  commitTree,
  fakeVp,
  installFixtureRuntime,
  initFixture,
  checkpoint,
  checkout,
  annotatedCheckpoint,
  remoteCommit,
  remoteMissing,
  recoveryWorktree,
  historicalFixture,
};
