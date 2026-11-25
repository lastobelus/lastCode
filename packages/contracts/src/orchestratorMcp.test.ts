import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpSaveScheduledTaskInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpThreadReadInput,
  ThreadReadResponse,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);
const decodeThreadReadInput = Schema.decodeSync(OrchestratorMcpThreadReadInput);
const decodeThreadReadResponse = Schema.decodeSync(ThreadReadResponse);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("keeps scheduled-task model selections through MCP JSON decoding", () => {
    const decode = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestratorMcpSaveScheduledTaskInput),
    );
    const model = { providerInstanceId: "claudeAgent", model: "claude-haiku-4-5" };
    for (const input of [
      { prompt: "Check the build", schedule: { type: "interval", everyMs: 60_000 } },
      { scheduledTaskId: "scheduled-task:1" },
    ]) {
      const modelSelection = { ...model, options: [{ id: "effort", value: "low" }] };
      expect(decode({ ...input, modelSelection }).modelSelection).toEqual(modelSelection);
      expect(decode(input).modelSelection).toBeUndefined();
    }
    expect(() => decode({ modelSelection: { providerInstanceId: "claudeAgent" } })).toThrow();
  });

  it("decodes a running-task next written by another version", () => {
    const next = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
    expect(
      decodeThreadWaitResult({
        threadId: "thread-child-1",
        runId: "run-child-1",
        status: "running",
        timedOut: true,
        next,
      }).next,
    ).toBe(next);
  });
});

describe("thread reference read routes", () => {
  it("preserves the explicit client route and owner for history pagination", () => {
    const read = decodeThreadReadInput({
      threadId: "thread-reference",
      environmentId: "environment-source",
      via: "client",
      afterPosition: 42,
    });
    expect(read).toMatchObject({
      threadId: "thread-reference",
      environmentId: "environment-source",
      via: "client",
      afterPosition: 42,
    });
  });

  it("preserves a sanitized exact-source permission refusal", () => {
    const response = decodeThreadReadResponse({
      connectionId: "connection-requester",
      requestId: "request-reference",
      result: null,
      unavailableEnvironmentIds: [],
      failure: { environmentId: "environment-source", reason: "permission_denied" },
    });
    expect(response).toMatchObject({
      failure: { environmentId: "environment-source", reason: "permission_denied" },
    });
  });
});
