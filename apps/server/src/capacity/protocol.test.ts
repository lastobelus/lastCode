import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ActionResumeToolkit } from "../mcp/toolkits/actionResume/tools.ts";
import { preferences } from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";

it("accepts launch and environment responses from servers without capacity support", () => {
  const launch = Schema.decodeUnknownSync(ProjectToolkit.tools.t3_thread_launch.successSchema)({
    threadId: "thread-example",
    projectId: "project-example",
    modelSelection: { instanceId: "codex", model: "example" },
    runId: null,
    status: null,
  });
  expect(launch.capacity).toBeUndefined();
  const { capacityMode: _capacityMode, ...olderPreferences } = preferences(DEFAULT_SERVER_SETTINGS);
  const environment = Schema.decodeUnknownSync(EnvironmentToolkit.tools.t3_environment_read.successSchema)({
    environmentId: "environment-example",
    label: "Older environment",
    serverVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    preferences: olderPreferences,
  });
  expect(environment.capacity).toBeUndefined();
});

it("accepts delegation, thread creation and Action results without a capacity block", () => {
  const delegation = Schema.decodeUnknownSync(OrchestratorToolkit.tools.delegate_task.successSchema)({
    taskId: "task-example",
    childThreadId: "child-example",
    childRunId: null,
    childNodeId: "node-example",
    status: "starting",
    workState: "working",
    hasPendingChildRuns: false,
    latestTerminalRunId: null,
    latestTerminalStatus: null,
    latestTerminalSummary: null,
    latestTerminalResultContextTransferId: null,
    providerInstanceId: "codex",
    model: null,
    summary: null,
    resultContextTransferId: null,
    hasPendingQuestion: false,
    pendingApproval: null,
    waitTimedOut: false,
  });
  expect(delegation.capacity).toBeUndefined();
  const created = Schema.decodeUnknownSync(OrchestratorToolkit.tools.create_threads.successSchema)({
    threads: [],
  });
  expect(created.capacity).toBeUndefined();
  const action = Schema.decodeUnknownSync(ActionResumeToolkit.tools.run_project_action_and_resume.successSchema)({
    runId: "run-example",
    threadId: "thread-example",
    projectId: "project-example",
    actionId: "action-example",
    actionName: "Example Action",
    terminalId: "terminal-example",
    outcome: "running",
    delivery: "armed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
  });
  expect(action.capacity).toBeUndefined();
});
