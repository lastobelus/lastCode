// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - Focused host-side fixture contract tests use disposable directories and child Node processes.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import {
  PUBLIC_DOCS_PROJECT_ID,
  PUBLIC_DOCS_PROJECTS,
  PUBLIC_DOCS_THREAD_ID,
  PUBLIC_DOCS_THREADS,
  seedShowcaseProjectWorkspace,
} from "./mobile-showcase-environment.ts";
import {
  parsePublicDocsFixtureCliArgs,
  preparePublicDocsDesktopFixture,
  redactFixtureCredentials,
  resolveSourceCommit,
  resolvePackagedUserDataDirectory,
  runPublicDocsFixture,
} from "./lastcode-public-doc-fixtures.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

async function expectRejected(promise: Promise<unknown>, pattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.instanceOf(caught, Error);
  if (pattern) assert.match(String(caught), pattern);
}

it("requires an explicit commit and output directory", () => {
  assert.deepEqual(
    parsePublicDocsFixtureCliArgs([
      "--commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--output",
      "/tmp/lastcode-docs-fixture",
    ]),
    {
      commit: "0123456789abcdef0123456789abcdef01234567",
      outputDirectory: "/tmp/lastcode-docs-fixture",
    },
  );
  assert.throws(() => parsePublicDocsFixtureCliArgs(["--output", "/tmp/fixture"]), /--commit/u);
  assert.throws(() => parsePublicDocsFixtureCliArgs(["--commit", "abc"]), /--output/u);
  assert.throws(
    () => parsePublicDocsFixtureCliArgs(["--commit", "abc", "--live-home", "/tmp/live"]),
    /Unknown argument/u,
  );
});

it("rejects a dirty checkout as a capture source", async () => {
  const repoRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "lastcode-public-doc-source-test-"),
  );
  try {
    await execFile("git", ["init", "-b", "main"], { cwd: repoRoot });
    await NodeFSP.writeFile(NodePath.join(repoRoot, "README.md"), "# Fixture source\n");
    await execFile("git", ["add", "README.md"], { cwd: repoRoot });
    await execFile(
      "git",
      [
        "-c",
        "user.name=LastCode Docs Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Seed source",
      ],
      { cwd: repoRoot },
    );
    const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(await resolveSourceCommit(head.trim(), repoRoot), head.trim());
    await NodeFSP.writeFile(NodePath.join(repoRoot, "uncommitted.txt"), "dirty\n");
    await expectRejected(resolveSourceCommit(head.trim(), repoRoot), /checkout must be clean/u);
  } finally {
    await NodeFSP.rm(repoRoot, { recursive: true, force: true });
  }
});

it("defines one synthetic public-doc project with representative thread states", () => {
  assert.equal(PUBLIC_DOCS_PROJECTS.length, 1);
  assert.equal(PUBLIC_DOCS_PROJECTS[0]?.id, PUBLIC_DOCS_PROJECT_ID);
  assert.equal(
    PUBLIC_DOCS_PROJECTS[0]?.repositoryUrl,
    "https://github.com/example/lastcode-docs-demo.git",
  );
  assert.equal(PUBLIC_DOCS_THREADS[0]?.id, PUBLIC_DOCS_THREAD_ID);
  assert.equal(
    PUBLIC_DOCS_THREADS.some((thread) => "annotation" in thread),
    true,
  );
  assert.equal(
    PUBLIC_DOCS_THREADS.some((thread) => "pinned" in thread && thread.pinned),
    true,
  );
  assert.equal(
    PUBLIC_DOCS_THREADS.some((thread) => "settled" in thread && thread.settled),
    true,
  );
  assert.equal(
    PUBLIC_DOCS_THREADS.some((thread) => "state" in thread && thread.state === "plan"),
    true,
  );
  for (const thread of PUBLIC_DOCS_THREADS) {
    assert.equal(thread.projectId, PUBLIC_DOCS_PROJECT_ID);
  }
});

it("redacts pairing and JSON credentials from diagnostic output", () => {
  assert.equal(
    redactFixtureCredentials(
      'pairingUrl: http://127.0.0.1:5173/#token=PAIR-ME&next=1 {"credential":"SECRET"}',
    ),
    'pairingUrl: http://127.0.0.1:5173/#token=[redacted]&next=1 {"credential":"[redacted]"}',
  );
});

it("resolves isolated packaged-app data paths on every supported desktop platform", () => {
  assert.equal(
    resolvePackagedUserDataDirectory("/fixture/home", "darwin"),
    "/fixture/home/Library/Application Support/lastcode",
  );
  assert.equal(
    resolvePackagedUserDataDirectory("/fixture/home", "linux"),
    "/fixture/home/.config/lastcode",
  );
  assert.equal(
    resolvePackagedUserDataDirectory("C:\\fixture\\home", "win32"),
    NodePath.join("C:\\fixture\\home", "AppData", "Roaming", "lastcode"),
  );
});

it("seeds a one-project mobile companion workspace", async () => {
  const workspaceRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "lastcode-mobile-companion-fixture-test-"),
  );
  try {
    await seedShowcaseProjectWorkspace({ workspaceRoot, projectId: "react" });
    assert.include(
      await NodeFSP.readFile(NodePath.join(workspaceRoot, "README.md"), "utf8"),
      "React",
    );
    const remote = await execFile("git", ["remote", "get-url", "origin"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    assert.equal(remote.stdout.trim(), "https://github.com/facebook/react.git");
  } finally {
    await NodeFSP.rm(workspaceRoot, { recursive: true, force: true });
  }
});

it("prepares a fake packaged updater that emits valid inspect and build states", async () => {
  const outputDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "lastcode-public-doc-fixture-test-"),
  );
  const baseDir = NodePath.join(outputDirectory, "environment");
  const homeDirectory = NodePath.join(outputDirectory, "home");
  try {
    await preparePublicDocsDesktopFixture({ outputDirectory, baseDir, homeDirectory });
    const dashboard = JSON.parse(
      await NodeFSP.readFile(NodePath.join(homeDirectory, ".lastcode", "dashboard.json"), "utf8"),
    ) as { readonly repoRoot: string };
    const helperPath = NodePath.join(dashboard.repoRoot, "scripts", "lastcode-local-update.mjs");
    const inspect = await execFile(
      NodeProcess.execPath,
      [
        helperPath,
        "inspect",
        "--repo",
        dashboard.repoRoot,
        "--home",
        homeDirectory,
        "--current-version",
        "0.0.12-nightly.20260829.1190",
        "--release-notes-format",
        "grouped-v1",
      ],
      { encoding: "utf8" },
    );
    const inspectResult = JSON.parse(
      inspect.stdout.slice(inspect.stdout.indexOf("=") + 1),
    ) as Record<string, unknown>;
    assert.deepInclude(inspectResult, {
      schemaVersion: 2,
      status: "available",
      availableVersion: "0.0.13-nightly.20260830.1200.1",
    });

    const build = await execFile(
      NodeProcess.execPath,
      [
        helperPath,
        "build",
        "--repo",
        dashboard.repoRoot,
        "--home",
        homeDirectory,
        "--checkpoint",
        "lastcode/revision/v0.0.13-nightly.20260830.1200.1",
      ],
      { encoding: "utf8" },
    );
    const buildResult = JSON.parse(build.stdout.slice(build.stdout.indexOf("=") + 1)) as {
      readonly schemaVersion: number;
      readonly status: string;
      readonly dmgPath: string;
      readonly dmgSha256: string;
    };
    assert.deepInclude(buildResult, { schemaVersion: 1, status: "built" });
    assert.match(buildResult.dmgSha256, /^[a-f0-9]{64}$/u);
    await NodeFSP.access(buildResult.dmgPath);
    const buildLog = await NodeFSP.readFile(
      NodePath.join(homeDirectory, ".lastcode", "local-updates", "build.log"),
      "utf8",
    );
    assert.include(buildLog, "[lastcode:ci] 4/11 Workspace tests");
    assert.include(buildLog, "[desktop-artifact] Building mac/dmg");

    const desktopSettings = JSON.parse(
      await NodeFSP.readFile(NodePath.join(baseDir, "userdata", "desktop-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(desktopSettings.showAndInstallLocalNightlies, true);
  } finally {
    await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
  }
});

it("runs the public-doc fixture lifecycle in isolated state", async () => {
  const outputDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "lastcode-public-doc-lifecycle-test-"),
  );
  const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  let ready: Record<string, unknown> | undefined;
  try {
    await runPublicDocsFixture(
      { commit: head.trim(), outputDirectory },
      {
        resolveSourceCommit: async (requestedCommit) => requestedCommit,
        waitForShutdown: async () => {},
        writeReady: (value) => {
          ready = value;
        },
      },
    );
    if (!ready) throw new Error("Fixture did not emit ready metadata.");
    assert.equal(ready.sourceCommit, head.trim());
    assert.equal(ready.projectId, PUBLIC_DOCS_PROJECT_ID);
    assert.match(String(ready.pairingUrl), /#token=/u);
    await expectRejected(fetch(String(ready.serverOrigin), { signal: AbortSignal.timeout(1_000) }));

    const metadataText = await NodeFSP.readFile(
      NodePath.join(outputDirectory, "fixture.json"),
      "utf8",
    );
    assert.notInclude(metadataText, "token=");
    assert.notInclude(metadataText, "credential");
    const metadata = JSON.parse(metadataText) as { readonly sourceCommit: string };
    assert.equal(metadata.sourceCommit, head.trim());

    const database = new NodeSqlite.DatabaseSync(
      NodePath.join(outputDirectory, "environment", "userdata", "state.sqlite"),
      { readOnly: true },
    );
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM projection_threads WHERE project_id = ?")
        .get(PUBLIC_DOCS_PROJECT_ID) as { readonly count: number };
      assert.equal(row.count, PUBLIC_DOCS_THREADS.length);

      const projectionState = database
        .prepare(
          "SELECT MIN(last_applied_sequence) AS minimum, MAX(last_applied_sequence) AS maximum FROM projection_state",
        )
        .get() as { readonly minimum: number; readonly maximum: number };
      assert.deepEqual(projectionState, { minimum: 0, maximum: 0 });
    } finally {
      database.close();
    }

    const commitIdentity = await execFile("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: NodePath.join(outputDirectory, "environment", "workspace", "lastcode-docs-demo"),
      encoding: "utf8",
    });
    assert.equal(commitIdentity.stdout.trim(), "LastCode Docs Fixture <fixture@example.invalid>");
  } finally {
    await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
  }
}, 90_000);
