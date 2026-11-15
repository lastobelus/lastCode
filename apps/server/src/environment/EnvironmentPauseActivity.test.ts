import { expect, it } from "@effect/vitest";
import {
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UpdateDrainBlocker,
} from "@t3tools/contracts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { pauseActivity, pauseExecutionBlockers } from "./EnvironmentPauseActivity.ts";

const threadId = ThreadId.make("pause-caller");
const runId = RunId.make("pause-caller-run");
const caller = {
  threadId,
  runId,
  providerSessionId: ProviderSessionId.make("pause-caller-provider"),
};

it("excludes only the reporting caller's current turn and preserves its independent work", () => {
  const thread = liveThreadShell(threadId, { activeRunId: runId });
  const activity = (candidate = thread, reportingCaller = caller) =>
    pauseActivity([candidate], [], true, reportingCaller).activeThread(candidate);

  expect(activity()).toBe(false);
  expect(activity(thread, { ...caller, runId: RunId.make("previous-run") })).toBe(true);
  expect(
    activity({
      ...thread,
      actionResume: {
        runId: "action-run",
        threadId,
        projectId: thread.projectId,
        actionId: "tests",
        actionName: "Tests",
        terminalId: "action-terminal",
        outcome: "running",
        delivery: "armed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
        exitCode: null,
        exitSignal: null,
      },
    }),
  ).toBe(true);
  expect(
    activity({
      ...thread,
      pendingRuntimeRequest: {
        kind: "permission",
        id: RuntimeRequestId.make("approval"),
        createdAt: thread.createdAt,
      },
    }),
  ).toBe(true);
  expect(
    activity({
      ...thread,
      pendingBackgroundTasks: [{ kind: "command", taskId: "command", description: "Tests" }],
    }),
  ).toBe(true);
  expect(pauseActivity([thread], [], true).activeThread(thread)).toBe(true);
});

it("filters caller execution and owned preview servers while retaining real work", () => {
  const otherThreadId = ThreadId.make("other-thread");
  const thread = liveThreadShell(threadId, { activeRunId: runId });
  const terminal = (terminalId: string, owner = threadId): UpdateDrainBlocker => ({
    type: "terminal-process",
    threadId: owner,
    terminalId,
    label: "python3",
    status: "running",
  });
  const blockers: UpdateDrainBlocker[] = [
    { type: "thread-turn", threadId, turnId: TurnId.make(runId), status: "running" },
    { type: "provider-runtime", providerSessionId: caller.providerSessionId, status: "running" },
    terminal("owned-server"),
    { type: "thread-turn", threadId, turnId: null, status: "starting" },
    { type: "thread-turn", threadId: otherThreadId, turnId: null, status: "running" },
    { type: "thread-background", threadId, status: "working" },
    { type: "thread-cleanup", threadId },
    { type: "provider-teardown", threadId },
    { type: "provider-runtime", providerSessionId: caller.providerSessionId, status: "stopping" },
    {
      type: "provider-runtime",
      providerSessionId: ProviderSessionId.make("other-provider"),
      status: "running",
    },
    terminal("ordinary-command"),
    terminal("owned-server", otherThreadId),
    terminal("preview-cleanup"),
  ];
  const previews = [
    { threadId, terminalId: "owned-server" },
    { threadId, terminalId: "preview-cleanup", cleanupPending: true },
  ];

  expect(pauseExecutionBlockers(blockers, [thread], caller, previews)).toEqual(blockers.slice(3));
  expect(pauseExecutionBlockers(blockers, [thread], null, previews)).toEqual(
    blockers.filter((_, index) => index !== 2),
  );
  expect(
    pauseExecutionBlockers(
      blockers,
      [{ ...thread, activeRunId: RunId.make("replacement-run") }],
      caller,
      previews,
    ),
  ).toEqual(blockers.filter((_, index) => index !== 2));
});
