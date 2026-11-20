// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { gradeSample, McpToolUseCase, type SampleRun } from "./run.ts";

const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(McpToolUseCase));
const recovery = decodeCase(
  NodeFS.readFileSync(
    new URL("./cases/local-project-delegation.ndjson", import.meta.url),
    "utf8",
  ).split("\n")[0],
);
const threadId = "11111111-1111-4111-8111-111111111111";
const environmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const callback = (thread: string, environment: string, mode: string) =>
  `Fix CSV. When done, call t3_thread_send with threadId: '${thread}', environmentId: '${environment}', mode: '${mode}', and a stable clientRequestId.`;

it.each([
  ["valid launch", callback(threadId, environmentId, "queue"), "origin/main", null, true],
  ["swapped destination", callback(environmentId, threadId, "queue"), "origin/main", null, false],
  [
    "correct caller in context but wrong callback destination",
    `Parent context: threadId ${threadId}, environmentId ${environmentId}. ${callback("22222222-2222-4222-8222-222222222222", environmentId, "queue")}`,
    "origin/main",
    null,
    false,
  ],
  [
    "wrong mode with a queue mention",
    `${callback(threadId, environmentId, "auto")} The queue will receive it.`,
    "origin/main",
    null,
    false,
  ],
  ["invalid base", callback(threadId, environmentId, "queue"), "origin/missing", null, false],
  [
    "shell checkout requested in the brief",
    `${callback(threadId, environmentId, "queue")} Before editing, run \x60git worktree add /tmp/report\x60.`,
    "origin/main",
    null,
    false,
  ],
  [
    "shell checkout explicitly prohibited in the brief",
    `${callback(threadId, environmentId, "queue")} Do not run \x60git worktree add\x60.`,
    "origin/main",
    null,
    true,
  ],
  [
    "shell checkout from argv",
    callback(threadId, environmentId, "queue"),
    "origin/main",
    `python -c 'import subprocess; subprocess.run(["git", "worktree", "add", "/tmp/report"])'`,
    false,
  ],
])("grades a recovery with %s", (_name, message, baseRef, command, pass) => {
  const calls: SampleRun["calls"][number][] = [
    {
      step: 0,
      tool: "t3_thread_launch",
      failed: false,
      input: {
        projectId: "acme-reports",
        workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: true },
        message,
      },
    },
  ];
  if (command !== null) calls.push({ step: 1, tool: "Bash", input: { command } });
  expect(
    gradeSample(recovery.expect, { calls, text: "", stopReason: "end_turn" }).every(
      (check) => check.pass,
    ),
  ).toBe(pass);
});
