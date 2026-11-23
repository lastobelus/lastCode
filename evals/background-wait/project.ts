// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { Arm, Scenario } from "./cases.ts";
import { projectNotes } from "./cases.ts";
import type { FixtureConfig } from "./fixture-script.ts";

export const root = NodePath.resolve(import.meta.dirname, "../..");
const baselineHead = "4e02407324ab0471e4cf93422772c8e7cf4fc4fb";
export const git = (args: string[], cwd = root) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export async function cli(
  base: string,
  args: [command: string, subcommand: string, ...flags: string[]],
) {
  const [command, subcommand, ...flags] = args;
  const { stdout } = await exec(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      command,
      subcommand,
      "--base-dir",
      base,
      ...flags,
    ],
    { cwd: root, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

export function guidance(arm: Arm) {
  return arm === "a"
    ? git(["show", `${baselineHead}:AGENTS.md`])
    : NodeFS.readFileSync(NodePath.join(root, "AGENTS.md"), "utf8");
}

export function repositoryFile(relativePath: string) {
  return NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
}

export type WrapperLine = "original" | "registered";
const wrapperScript = "scripts/lastcode-run.ts";
const waitInstructionDeclaration = /^const WAIT_INSTRUCTION\s*=\s*("(?:[^"\\]|\\.)*");/mu;

export function wrapperWaitInstruction(variant: WrapperLine = "registered"): string {
  const source =
    variant === "original"
      ? git(["show", `${baselineHead}:${wrapperScript}`])
      : repositoryFile(wrapperScript);
  const literal = source.match(waitInstructionDeclaration)?.[1];
  if (literal === undefined) throw new Error("Could not read the wrapper's wait instruction.");
  return JSON.parse(literal) as string;
}

function shellArg(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function makeProject(
  workspace: string,
  arm: Arm,
  scenario: Scenario,
  seconds: number,
  waitInstruction?: string,
) {
  NodeFS.mkdirSync(workspace);
  const scripts = NodePath.join(workspace, "scripts");
  const shared = NodePath.join(workspace, "packages/shared/src");
  NodeFS.mkdirSync(NodePath.join(scripts, "lib"), { recursive: true });
  NodeFS.mkdirSync(shared, { recursive: true });
  const wrapperSource = repositoryFile(wrapperScript);
  const fixtureWrapper =
    waitInstruction === undefined
      ? wrapperSource
      : wrapperSource.replace(
          waitInstructionDeclaration,
          () => `const WAIT_INSTRUCTION = ${JSON.stringify(waitInstruction)};`,
        );
  NodeFS.writeFileSync(NodePath.join(workspace, wrapperScript), fixtureWrapper);
  NodeFS.copyFileSync(
    NodePath.join(root, "scripts/lib/lastcode-action-kit.ts"),
    NodePath.join(scripts, "lib/lastcode-action-kit.ts"),
  );
  NodeFS.copyFileSync(
    NodePath.join(root, "packages/shared/src/lastcodeWrappedCommands.ts"),
    NodePath.join(shared, "lastcodeWrappedCommands.ts"),
  );
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "fixture-script.ts"),
    NodePath.join(scripts, "fixture.ts"),
  );
  NodeFS.copyFileSync(NodePath.join(root, "CLAUDE.md"), NodePath.join(workspace, "CLAUDE.md"));
  NodeFS.writeFileSync(
    NodePath.join(scripts, "lc-run"),
    `#!/bin/sh\nexec ${shellArg(process.execPath)} "$(dirname "$0")/lastcode-run.ts" "$@"\n`,
  );
  NodeFS.chmodSync(NodePath.join(scripts, "lc-run"), 0o755);
  NodeFS.writeFileSync(
    NodePath.join(workspace, "AGENTS.md"),
    guidance(arm) + "\n## This project\n\n" + projectNotes(scenario, arm) + "\n",
  );

  const config: FixtureConfig = {
    workspace,
    script: scenario.script,
    args: scenario.args ?? [],
    seconds,
    exitCode: scenario.exitCode,
    stages: scenario.stages ?? 1,
  };
  const scriptFiles = new Set([scenario.script]);
  if (scenario.wrapper[0] === "ci") scriptFiles.add("prepare-dependencies.ts");
  if (scenario.stages !== undefined) scriptFiles.add("ack.ts");
  for (const file of scriptFiles) {
    NodeFS.writeFileSync(
      NodePath.join(scripts, file),
      [
        'import { runFixture } from "./fixture.ts";',
        'import { lastCodeAction } from "./lib/lastcode-action-kit.ts";',
        `const config = ${JSON.stringify(config)};`,
        "const result = await runFixture(config);",
        "if (result !== undefined) {",
        "  lastCodeAction.result(result);",
        "  process.exitCode = config.exitCode;",
        "}",
        "",
      ].join("\n"),
    );
  }
  const commandFor = (script: string, args: string[]) =>
    [process.execPath, `./scripts/${script}`, ...args].map(shellArg).join(" ");
  const command = [
    ...(scenario.wrapper[0] === "ci" ? [commandFor("prepare-dependencies.ts", ["--for-ci"])] : []),
    commandFor(scenario.script, scenario.args ?? []),
  ].join(" && ");
  NodeFS.writeFileSync(
    NodePath.join(workspace, "t3.json"),
    JSON.stringify(
      {
        scripts: [{ id: scenario.actionId, name: scenario.name, command, icon: "test" }],
      },
      null,
      2,
    ) + "\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(workspace, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  NodeFS.writeFileSync(
    NodePath.join(workspace, ".gitignore"),
    "/work.jsonl\n/action-state.json\n/artifacts/\n",
  );
  git(["init", "--initial-branch=main", "--template="], workspace);
  git(["add", "."], workspace);
  git(
    [
      "-c",
      "user.name=Wait Eval",
      "-c",
      "user.email=wait-eval@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Create fixture",
    ],
    workspace,
  );
}

export async function registerProject(base: string, workspace: string, scenario: Scenario) {
  const output = await cli(base, [
    "project",
    "reconcile-actions",
    "--create-if-missing",
    "--source-file",
    NodePath.join(workspace, "t3.json"),
    "--state-file",
    NodePath.join(workspace, "action-state.json"),
    "--trusted-source-ids",
    scenario.actionId,
    workspace,
  ]);
  const result = JSON.parse(output) as { projectId?: string; mode?: string };
  if (!result.projectId || result.mode !== "live") {
    throw new Error("Fixture registration did not reach the running dev server.");
  }
  return result.projectId;
}
