import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ActionResumeToolkit } from "../mcp/toolkits/actionResume/tools.ts";
import { preferences } from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";

const decodeLaunch = Schema.decodeSync(ProjectToolkit.tools.t3_thread_launch.successSchema);
const decodeEnvironment = Schema.decodeSync(
  EnvironmentToolkit.tools.t3_environment_read.successSchema,
);
const decodeDelegation = Schema.decodeSync(OrchestratorToolkit.tools.delegate_task.successSchema);
const decodeCreated = Schema.decodeSync(OrchestratorToolkit.tools.create_threads.successSchema);
const decodeAction = Schema.decodeSync(
  ActionResumeToolkit.tools.run_project_action_and_resume.successSchema,
);

it("accepts launch and environment responses from servers without capacity support", () => {
  const launch = decodeLaunch({
    threadId: "thread-example",
    projectId: "project-example",
    modelSelection: { instanceId: "codex", model: "example" },
    runId: null,
    status: null,
  });
  expect(launch.capacity).toBeUndefined();
  const { capacityMode: _capacityMode, ...olderPreferences } = preferences(DEFAULT_SERVER_SETTINGS);
  const environment = decodeEnvironment({
    environmentId: "environment-example",
    label: "Older environment",
    serverVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    preferences: olderPreferences,
  });
  expect(environment.capacity).toBeUndefined();
});

it("accepts delegation, thread creation and Action results without a capacity block", () => {
  const delegation = decodeDelegation({
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
  const created = decodeCreated({
    threads: [],
  });
  expect(created.capacity).toBeUndefined();
  const action = decodeAction({
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
