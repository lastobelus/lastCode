// @effect-diagnostics nodeBuiltinImport:off -- Exercises saved launch commands with disposable external tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const packageJson = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const projectConfig = JSON.parse(
  NodeFS.readFileSync(new URL("../t3.json", import.meta.url), "utf8"),
) as { scripts: Array<{ name: string; command: string }> };

function withLaunchFixture(
  run: (fixture: ReturnType<typeof createLaunchFixture>) => void,
  targetVersion = "26.12.1",
) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode node launch ")),
  );
  try {
    run(createLaunchFixture(root, targetVersion));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function createLaunchFixture(root: string, targetVersion: string) {
  const cwd = NodePath.join(root, "checkout with spaces");
  const projectRoot = NodePath.join(root, "primary checkout with spaces");
  const pinnedBin = NodePath.join(root, "pinned bin");
  const legacyBin = NodePath.join(root, "legacy pinned bin");
  const ambientBin = NodePath.join(root, "ambient bin");
  const toolBin = NodePath.join(root, "external tools");
  const checkoutBin = NodePath.join(cwd, "node_modules", ".bin");
  for (const directory of [
    cwd,
    projectRoot,
    pinnedBin,
    legacyBin,
    ambientBin,
    toolBin,
    checkoutBin,
  ]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const pinnedNode = NodePath.join(pinnedBin, "node");
  const legacyNode = NodePath.join(legacyBin, "node");
  // A copied executable gives process.execPath an observable identity independent of PATH shims.
  NodeFS.copyFileSync(process.execPath, pinnedNode);
  NodeFS.chmodSync(pinnedNode, 0o755);
  NodeFS.copyFileSync(process.execPath, legacyNode);
  NodeFS.chmodSync(legacyNode, 0o755);
  const writeExecutable = (path: string, source: string) => {
    NodeFS.writeFileSync(path, source, { mode: 0o755 });
  };
  for (const directory of [ambientBin, checkoutBin]) {
    writeExecutable(
      NodePath.join(directory, "node"),
      '#!/bin/sh\nexec "$FIXTURE_AMBIENT_NODE" "$@"\n',
    );
  }
  writeExecutable(
    NodePath.join(toolBin, "mise"),
    `#!/bin/sh
[ "$1" = exec ] && [ "$3" = -- ] || exit 90
case "$2" in
  node@26.12.1) selected="$FIXTURE_PINNED_BIN" ;;
  node@24.13.1) selected="$FIXTURE_LEGACY_BIN" ;;
  *) exit 90 ;;
esac
shift 3
# Model mise restoring pristine PATH entries unless aggressive activation is explicit.
if [ "$MISE_ACTIVATE_AGGRESSIVE" = 1 ]; then
  PATH="$selected:$FIXTURE_CHECKOUT_BIN:$FIXTURE_TOOL_BIN:$FIXTURE_AMBIENT_BIN:/usr/bin:/bin"
else
  PATH="$FIXTURE_AMBIENT_BIN:$FIXTURE_CHECKOUT_BIN:$FIXTURE_TOOL_BIN:$selected:/usr/bin:/bin"
fi
export PATH
exec "$@"
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        "lastcode:ci": `MISE_ACTIVATE_AGGRESSIVE=1 mise exec node@${targetVersion} -- node scripts/lastcode-local-ci.ts --full`,
      },
    }),
  );
  const leaf = `const { spawnSync } = require('node:child_process');
const path = require('node:path');
const grandchild = spawnSync('node', ['-e', 'console.log(JSON.stringify({ executable: process.execPath, version: process.version }))'], { encoding: 'utf8' });
if (grandchild.error) throw grandchild.error;
if (grandchild.status !== 0) process.exit(grandchild.status ?? 1);
const name = path.basename(process.argv[1]);
console.log(JSON.stringify({ name, executable: process.execPath, version: process.version, cwd: process.cwd(), args: process.argv.slice(2), grandchild: JSON.parse(grandchild.stdout) }));
process.exit(Number(name === process.env.FIXTURE_FAIL_LEAF ? process.env.FIXTURE_EXIT_CODE : 0));
`;
  for (const [directory, name] of [
    [cwd, "lastcode-pr-gates.ts"],
    [cwd, "lastcode-local-ci.ts"],
    [projectRoot, "prepare-dependencies.ts"],
  ] as const) {
    NodeFS.mkdirSync(NodePath.join(directory, "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "scripts", name), leaf);
  }
  return {
    cwd,
    pinnedNode,
    ciNode: targetVersion === "24.13.1" ? legacyNode : pinnedNode,
    run(command: string, args: string[], failLeaf: string, exitCode: number) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: [checkoutBin, pinnedBin, toolBin, ambientBin, "/usr/bin", "/bin"].join(
          NodePath.delimiter,
        ),
        MISE_ACTIVATE_AGGRESSIVE: "0",
        T3CODE_PROJECT_ROOT: projectRoot,
        FIXTURE_PINNED_BIN: pinnedBin,
        FIXTURE_LEGACY_BIN: legacyBin,
        FIXTURE_TOOL_BIN: toolBin,
        FIXTURE_AMBIENT_BIN: ambientBin,
        FIXTURE_CHECKOUT_BIN: checkoutBin,
        FIXTURE_AMBIENT_NODE: process.execPath,
        FIXTURE_FAIL_LEAF: failLeaf,
        FIXTURE_EXIT_CODE: String(exitCode),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        ["-c", `${command} "$@"`, "launcher", ...args],
        {
          cwd,
          env,
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(exitCode);
      return result.stdout
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              name: string;
              executable: string;
              version: string;
              cwd: string;
              args: string[];
              grandchild: { executable: string; version: string };
            },
        );
    },
  };
}

function expectPinned(
  fixture: ReturnType<typeof createLaunchFixture>,
  records: ReturnType<ReturnType<typeof createLaunchFixture>["run"]>,
) {
  for (const record of records) {
    const expectedNode =
      record.name === "lastcode-local-ci.ts" ? fixture.ciNode : fixture.pinnedNode;
    expect(record.executable).toBe(expectedNode);
    expect(record.version).toBe(process.version);
    expect(record.cwd).toBe(NodeFS.realpathSync(fixture.cwd));
    expect(record.grandchild).toEqual({ executable: expectedNode, version: process.version });
  }
}

describe("saved LastCode Node launchers", () => {
  it("pins a maintenance package command and its bare-node grandchild, preserving arguments and exit status", () => {
    withLaunchFixture((fixture) => {
      const args = ["--pr", "123", "argument with spaces", "literal $value; text"];
      const records = fixture.run(
        packageJson.scripts["lastcode:pr-gates"]!,
        args,
        "lastcode-pr-gates.ts",
        23,
      );
      expect(records.map(({ name, args }) => ({ name, args }))).toEqual([
        { name: "lastcode-pr-gates.ts", args },
      ]);
      expectPinned(fixture, records);
    });
  });

  it.each([
    { targetVersion: "26.12.1", mode: "--quick", failLeaf: "", exitCode: 0, runsCi: true },
    {
      targetVersion: "26.12.1",
      mode: "--quick",
      failLeaf: "prepare-dependencies.ts",
      exitCode: 29,
      runsCi: false,
    },
    {
      targetVersion: "26.12.1",
      mode: "--quick",
      failLeaf: "lastcode-local-ci.ts",
      exitCode: 31,
      runsCi: true,
    },
    { targetVersion: "24.13.1", mode: "--quick", failLeaf: "", exitCode: 0, runsCi: true },
    { targetVersion: "24.13.1", mode: "--full", failLeaf: "", exitCode: 0, runsCi: true },
    {
      targetVersion: "24.13.1",
      mode: "--full",
      failLeaf: "lastcode-local-ci.ts",
      exitCode: 31,
      runsCi: true,
    },
  ])(
    "pins preparation and uses target Node $targetVersion for $mode ($failLeaf, exit $exitCode)",
    ({ targetVersion, mode, failLeaf, exitCode, runsCi }) => {
      withLaunchFixture((fixture) => {
        const command = projectConfig.scripts
          .find(({ name }) => name === "Run Quick CI")!
          .command.replace("--quick", mode);
        const records = fixture.run(command, [], failLeaf, exitCode);
        expectPinned(fixture, records);
        expect(records.map(({ name, args }) => ({ name, args }))).toEqual([
          { name: "prepare-dependencies.ts", args: ["--for-ci"] },
          ...(runsCi ? [{ name: "lastcode-local-ci.ts", args: ["--full", mode] }] : []),
        ]);
      }, targetVersion);
    },
  );
});
