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

function withLaunchFixture(run: (fixture: ReturnType<typeof createLaunchFixture>) => void) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode node launch ")),
  );
  try {
    run(createLaunchFixture(root));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function createLaunchFixture(root: string) {
  const cwd = NodePath.join(root, "checkout with spaces");
  const projectRoot = NodePath.join(root, "primary checkout with spaces");
  const pinnedBin = NodePath.join(root, "pinned bin");
  const ambientBin = NodePath.join(root, "ambient bin");
  const toolBin = NodePath.join(root, "external tools");
  const checkoutBin = NodePath.join(cwd, "node_modules", ".bin");
  for (const directory of [cwd, projectRoot, pinnedBin, ambientBin, toolBin, checkoutBin]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const pinnedNode = NodePath.join(pinnedBin, "node");
  // A copied executable gives process.execPath an observable identity independent of PATH shims.
  NodeFS.copyFileSync(process.execPath, pinnedNode);
  NodeFS.chmodSync(pinnedNode, 0o755);
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
[ "$1" = exec ] && [ "$2" = node@24.13.1 ] && [ "$3" = -- ] || exit 90
shift 3
# Model mise restoring pristine PATH entries unless aggressive activation is explicit.
if [ "$MISE_ACTIVATE_AGGRESSIVE" = 1 ]; then
  PATH="$FIXTURE_PINNED_BIN:$FIXTURE_CHECKOUT_BIN:$FIXTURE_AMBIENT_BIN:/usr/bin:/bin"
else
  PATH="$FIXTURE_AMBIENT_BIN:$FIXTURE_CHECKOUT_BIN:$FIXTURE_PINNED_BIN:/usr/bin:/bin"
fi
export PATH
exec "$@"
`,
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
    run(command: string, args: string[], failLeaf: string, exitCode: number) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: [checkoutBin, pinnedBin, toolBin, ambientBin, "/usr/bin", "/bin"].join(
          NodePath.delimiter,
        ),
        MISE_ACTIVATE_AGGRESSIVE: "0",
        T3CODE_PROJECT_ROOT: projectRoot,
        FIXTURE_PINNED_BIN: pinnedBin,
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
    expect(record.executable).toBe(fixture.pinnedNode);
    expect(record.version).toBe(process.version);
    expect(record.cwd).toBe(NodeFS.realpathSync(fixture.cwd));
    expect(record.grandchild).toEqual({ executable: fixture.pinnedNode, version: process.version });
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
    { failLeaf: "", exitCode: 0, runsCi: true },
    { failLeaf: "prepare-dependencies.ts", exitCode: 29, runsCi: false },
    { failLeaf: "lastcode-local-ci.ts", exitCode: 31, runsCi: true },
  ])(
    "pins Run Quick CI preparation and execution ($failLeaf, exit $exitCode)",
    ({ failLeaf, exitCode, runsCi }) => {
      withLaunchFixture((fixture) => {
        const command = projectConfig.scripts.find(({ name }) => name === "Run Quick CI")!.command;
        const records = fixture.run(command, [], failLeaf, exitCode);
        expect(records.map(({ name, args }) => ({ name, args }))).toEqual([
          { name: "prepare-dependencies.ts", args: ["--for-ci"] },
          ...(runsCi ? [{ name: "lastcode-local-ci.ts", args: ["--quick"] }] : []),
        ]);
        expectPinned(fixture, records);
      });
    },
  );
});
