// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthSettingsWriteScope,
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProjectScript,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import type { Arm, Scenario } from "./cases.ts";
import { projectNotes } from "./cases.ts";
import type { FixtureConfig } from "./fixture-script.ts";

export const root = NodePath.resolve(import.meta.dirname, "../..");
export const serverCliOverride = process.env.LASTCODE_EVAL_SERVER_CLI;
const serverCli = serverCliOverride ?? NodePath.join(root, "apps/server/src/bin.ts");
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
export async function cli(base: string, command: readonly string[], flags: readonly string[] = []) {
  if (!NodePath.isAbsolute(serverCli)) {
    throw new Error("LASTCODE_EVAL_SERVER_CLI must be an absolute path to the server's bin.ts.");
  }
  const { stdout } = await exec(
    process.execPath,
    [serverCli, ...command, "--base-dir", base, ...flags],
    { cwd: root, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch((error: Error & { stdout?: string; stderr?: string }) => {
    if (
      error.stdout?.includes("ServerOwnsDatabaseError") ||
      error.stderr?.includes("ServerOwnsDatabaseError")
    ) {
      throw new Error(
        "The CLI cannot use the running eval server's database schema. Set LASTCODE_EVAL_SERVER_CLI to the running server checkout's bin.ts.",
      );
    }
    throw error;
  });
  return stdout;
}

export function guidance(arm: Arm) {
  return arm === "a"
    ? git(["show", `${baselineHead}:AGENTS.md`])
    : NodeFS.readFileSync(NodePath.join(root, "AGENTS.md"), "utf8");
}

export function fixtureGuidance(scenario: Scenario, arm: Arm) {
  const general = guidance(arm);
  const notes = "## This project\n\n" + projectNotes(scenario, arm) + "\n";
  // The watch recipe needs to survive Codex's project instruction byte limit.
  return scenario.stages === undefined ? `${general}\n${notes}` : `${notes}\n${general}`;
}

export function repositoryFile(relativePath: string) {
  return NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
}

const wrapperScript = "scripts/lastcode-run.ts";
const waitInstructionDeclaration = /^const WAIT_INSTRUCTION\s*=\s*("(?:[^"\\]|\\.)*");/mu;

export function wrapperWaitInstruction(): string {
  const literal = repositoryFile(wrapperScript).match(waitInstructionDeclaration)?.[1];
  if (literal === undefined)
    throw new Error(`${wrapperScript}: expected WAIT_INSTRUCTION to be a string literal.`);
  return JSON.parse(literal) as string;
}

function shellArg(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function makeProject(workspace: string, arm: Arm, scenario: Scenario, seconds: number) {
  NodeFS.mkdirSync(workspace);
  const scripts = NodePath.join(workspace, "scripts");
  const shared = NodePath.join(workspace, "packages/shared/src");
  NodeFS.mkdirSync(NodePath.join(scripts, "lib"), { recursive: true });
  NodeFS.mkdirSync(shared, { recursive: true });
  NodeFS.copyFileSync(NodePath.join(root, wrapperScript), NodePath.join(workspace, wrapperScript));
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
  NodeFS.writeFileSync(NodePath.join(workspace, "AGENTS.md"), fixtureGuidance(scenario, arm));

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
  const output = await cli(
    base,
    ["project", "reconcile-actions"],
    [
      "--create-if-missing",
      "--source-file",
      NodePath.join(workspace, "t3.json"),
      "--state-file",
      NodePath.join(workspace, "action-state.json"),
      "--trusted-source-ids",
      scenario.actionId,
      workspace,
    ],
  );
  const result = JSON.parse(output) as { projectId?: string; mode?: string };
  if (!result.projectId || result.mode !== "live") {
    throw new Error("Fixture registration did not reach the running dev server.");
  }
  return result.projectId;
}

const decodeProjectScripts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);

export async function configureFixtureAction(
  base: string,
  origin: URL,
  db: NodeSqlite.DatabaseSync,
  projectId: string,
  actionId: string,
) {
  // Reconciliation writes the legacy project record. Folded homes resolve
  // Actions from settings, so install the reconciled fixture there as well.
  const row = db
    .prepare("SELECT scripts_json FROM projection_projects WHERE project_id = ?")
    .get(projectId);
  const scripts = decodeProjectScripts(row?.scripts_json);
  const action = scripts.find((script) => script.id === actionId);
  if (action?.allowAgentResume !== true) {
    throw new Error(`Fixture Action ${actionId} was not saved with agent resume enabled.`);
  }
  const { sessionId, token } = JSON.parse(
    await cli(
      base,
      ["auth", "session", "issue"],
      [
        "--scope",
        AuthSettingsWriteScope,
        "--ttl",
        "2m",
        "--label",
        "background-wait eval",
        "--json",
      ],
    ),
  ) as { sessionId: string; token: string };
  try {
    const { ticket } = await HttpClient.execute(
      HttpClientRequest.post(new URL("/api/auth/websocket-ticket", origin).href).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("10 seconds"),
      Effect.runPromise,
    );
    const socket = new URL("/ws", origin);
    socket.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    socket.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
    socket.searchParams.set("wsTicket", Redacted.value(ticket));
    const id = ProjectId.make(projectId);
    const effective = await Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const settings = yield* client[WS_METHODS.serverUpdateSettings]({
        patch: { projectSettingsOverrides: { [id]: { defaultProjectScripts: [action] } } },
      });
      return resolveProjectScripts(settings, { id, scripts });
    }).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(socket.href)),
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(NodeWS.layerWebSocketConstructor),
        ),
      ),
      Effect.scoped,
      // Socket errors can include the URL with its single-use ticket.
      Effect.mapError(
        () =>
          new Error(`Could not save fixture Action ${actionId} through the local settings RPC.`),
      ),
      Effect.timeout("15 seconds"),
      Effect.runPromise,
    );
    if (
      !effective.some(
        (script) =>
          script.id === actionId &&
          script.allowAgentResume === true &&
          script.command === action.command,
      )
    ) {
      throw new Error(
        `Fixture Action ${actionId} is missing from the running server's effective settings.`,
      );
    }
  } finally {
    await cli(base, ["auth", "session", "revoke"], [sessionId]).catch(() => undefined);
  }
}
