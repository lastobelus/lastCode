// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { assertSupportedNodeVersion, resolveFullCiStampPath } from "./lastcode-local-ci.ts";

function fixtureNodeExecutable(): string {
  // Vite+ may host tests on a newer Node than the runtime required by the CI CLI.
  const candidates = [
    process.execPath,
    ...(process.env.PATH?.split(NodePath.delimiter).map((directory) =>
      NodePath.join(directory, "node"),
    ) ?? []),
  ];
  for (const node of new Set(candidates)) {
    if (!NodeFS.existsSync(node)) continue;
    const version = NodeChildProcess.spawnSync(node, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (version.status !== 0) continue;
    try {
      assertSupportedNodeVersion(version.stdout.trim());
      return node;
    } catch {
      // Ignore an unrelated runtime on PATH.
    }
  }
  throw new Error("CI collection fixture requires the supported project Node on PATH.");
}

it("collects later workspace failures and blocks stale output without writing a passing stamp", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-full-collection-"));
  const root = NodePath.join(directory, "repo");
  const bin = NodePath.join(directory, "bin");
  const calls = NodePath.join(directory, "calls.jsonl");
  const node = fixtureNodeExecutable();
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(bin);
  const write = (path: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text);
  };
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const executable = (name: string, body: string) => {
    const path = NodePath.join(bin, name);
    write(path, `#!${node}\n${body}\n`);
    NodeFS.chmodSync(path, 0o755);
  };
  try {
    git("init", "--initial-branch", "lastcode/main");
    git("config", "user.name", "CI collection fixture");
    git("config", "user.email", "fixture@example.invalid");
    write(NodePath.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    write(NodePath.join(root, ".gitignore"), "node_modules\n");
    for (const name of ["first", "later"]) {
      write(
        NodePath.join(root, "packages", name, "package.json"),
        JSON.stringify({
          name: `@fixture/${name}`,
          scripts: { test: "node test.cjs", typecheck: "node check.cjs" },
        }),
      );
    }
    write(
      NodePath.join(root, "scripts/release-smoke.ts"),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, JSON.stringify(['release-smoke'])+'\\n');`,
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "fixture candidate");
    const head = git("rev-parse", "HEAD");
    const nightly = "v1.2.3-nightly.20260811.1";
    const tag = `lastcode/checkpoint/${nightly}`;
    git("tag", nightly);
    git("tag", tag);
    executable(
      "vp",
      [
        "const fs = require('node:fs'); const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');`,
        "if (args.includes('test') || args.includes('build:desktop') || args.includes('check')) process.exit(1);",
      ].join("\n"),
    );
    executable("brew", "process.exit(1);");
    executable("rustup", `console.log(${JSON.stringify(NodePath.join(bin, "cargo"))});`);
    executable("cargo", "process.exit(0);");
    const preload = NodePath.join(directory, "isolated-home.mjs");
    write(
      preload,
      [
        "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';",
        `os.homedir = () => ${JSON.stringify(NodePath.join(directory, "home"))}; syncBuiltinESMExports();`,
      ].join("\n"),
    );
    const env = { ...process.env };
    delete env.T3CODE_ACTION_RUN_ID;
    delete env.T3CODE_ACTION_EVENT_TOKEN;
    const result = NodeChildProcess.spawnSync(
      node,
      [
        "--import",
        preload,
        NodePath.resolve(import.meta.dirname, "lastcode-local-ci.ts"),
        "--full",
        "--checkpoint",
        tag,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...env,
          PATH: [bin, NodePath.dirname(node), env.PATH ?? ""].join(NodePath.delimiter),
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    const reportPath = result.stdout.match(/Validation report: (.+)/)?.[1];
    expect(reportPath).toBeDefined();
    const report = JSON.parse(NodeFS.readFileSync(reportPath!, "utf8")) as {
      status: string;
      commit: string;
      steps: Array<{ label: string; status: string; blockedBy?: string[]; logPath: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.commit).toBe(head);
    expect(
      report.steps.find(({ label }) => label === "Workspace tests (@fixture/first)")?.status,
    ).toBe("failed");
    expect(
      report.steps.find(({ label }) => label === "Workspace tests (@fixture/later)")?.status,
    ).toBe("failed");
    expect(
      report.steps.find(({ label }) => label === "Desktop preload bundle assertions"),
    ).toMatchObject({ status: "blocked", blockedBy: ["Desktop build"] });
    expect(
      report.steps.find(({ label }) => label === "Mobile native static analysis")?.status,
    ).toBe("blocked");
    expect(report.steps.find(({ label }) => label === "Release smoke")?.status).toBe("passed");
    expect(
      report.steps.every(({ status }) => ["passed", "failed", "blocked"].includes(status)),
    ).toBe(true);
    expect(NodeFS.existsSync(resolveFullCiStampPath(NodePath.join(root, ".git"), head))).toBe(
      false,
    );
    expect(NodeFS.readFileSync(calls, "utf8")).toContain("@fixture/later");
    expect(git("status", "--porcelain")).toBe("");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
