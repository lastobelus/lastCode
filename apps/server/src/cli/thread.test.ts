import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { vi } from "vite-plus/test";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import {
  ProjectId,
  CommandId,
  ThreadId,
  EnvironmentId,
  MessageId,
  RunId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

import {
  THREAD_TRANSCRIPT_MAX_CHARS,
  THREAD_ACTIVITY_MAX_RESULTS,
  THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS,
  THREAD_LIST_MAX_RESULTS,
  type ThreadReadSource,
  type ThreadCliMessage,
  type ThreadCliActivity,
  type ThreadSendSource,
  ThreadCliError,
  boundThreadPresentation,
  boundTranscriptMessages,
  currentThreadOutput,
  listThreadsOutput,
  isAuthoritativeDispatchFailure,
  isPendingCurrentThreadWait,
  readThreadOutput,
  retryAmbiguousTrackedDispatch,
  resolveThreadTarget,
  sendThreadOutput,
  threadLifecycle,
  threadCommand,
  validateThreadTurnLimit,
  withReadSession,
  withSendSession,
  withThreadSendTimeout,
} from "./thread.ts";
import {
  readLatestMessages,
  resolveProject,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./threadMcp.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const DateTime = await import("effect/DateTime");
  const { AuthSessionId } = await import("@t3tools/contracts");
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect(
  "start resolves home-relative project paths while preserving ids and relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

it.effect("does not sign in to whatever took over a dead server's port", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-dead-server-" });
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
      state: { ...state, pid: 4_194_305 },
    });
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "list",
      "--project",
      "project-1",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadServerNotRunningError");
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

/** The reads that ask whether a run after `runId` holds a message someone sent. */
const laterRunReads = (
  laterRun: RunId,
  items: ReadonlyArray<{ readonly runId: RunId; readonly type: string }>,
) => [
  {
    recentRuns: [
      { runId, ordinal: 1 },
      { runId: laterRun, ordinal: 2 },
    ],
  },
  { thread: {}, items, nextPosition: null, hasMore: false },
];

it.effect("--wait lasts until background work the agent waits on wakes it and that run ends", () =>
  Effect.gen(function* () {
    const wakeRun = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "completed", timedOut: false },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId: wakeRun, status: "completed" },
        },
      ],
      // The wake run starts from a notification, which the messages view leaves out.
      t3_thread_read: laterRunReads(wakeRun, []),
    });

    const outcome = yield* waitForRun(tools, threadId, runId, true);

    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000, untilDelegatedWorkSettled: true },
      ],
    );
    assert.deepStrictEqual(outcome, { type: "ended", runId: wakeRun, status: "completed" });
  }),
);

it.effect(
  "--wait waits out the moment between background work ending and its wake run starting",
  () =>
    Effect.gen(function* () {
      const wakeRun = RunId.make("run-2");
      const ownOnly = { recentRuns: [{ runId, ordinal: 1, status: "completed" }] };
      const withWake = (status: string) => [
        {
          recentRuns: [
            { runId, ordinal: 1, status: "completed" },
            { runId: wakeRun, ordinal: 2, status },
          ],
        },
        { thread: {}, items: [], nextPosition: null, hasMore: false },
      ];
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          { threadId, runId, status: "completed", timedOut: true },
          // The work ended, and the run it wakes is not recorded yet.
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId, status: "completed" },
          },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: wakeRun, status: "completed" },
          },
        ],
        t3_thread_read: [
          ownOnly,
          { thread: { pendingRequestCount: 0 } },
          ownOnly,
          ...withWake("running"),
          ...withWake("completed"),
        ],
      });

      const fiber = yield* Effect.forkChild(waitForRun(tools, threadId, runId, true));
      yield* TestClock.adjust("500 millis");

      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        type: "ended",
        runId: wakeRun,
        status: "completed",
      });
    }),
);

it.effect(
  "--wait keeps its own run's result when another client's later run settles the thread",
  () =>
    Effect.gen(function* () {
      const sentRun = RunId.make("run-2");
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: sentRun, status: "failed" },
          },
        ],
        t3_thread_read: laterRunReads(sentRun, [{ runId: sentRun, type: "user_message" }]),
      });

      assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId, true), {
        type: "ended",
        runId,
        status: "completed",
      });
    }),
);

it.effect("waits for a slow send instead of abandoning it after the read probe budget", () =>
  Effect.gen(function* () {
    const dispatch = yield* withThreadSendTimeout(
      Effect.sleep("6 seconds").pipe(Effect.as("accepted")),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    assert.strictEqual(yield* Fiber.join(dispatch), "accepted");

    const stalled = yield* withThreadSendTimeout(Effect.never).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    assert.strictEqual((yield* Fiber.join(stalled))._tag, "TimeoutError");
  }),
);

it.effect("does not retry an authoritative tracked dispatch rejection", () =>
  Effect.gen(function* () {
    assert.isTrue(
      isAuthoritativeDispatchFailure({
        _tag: "EnvironmentInternalError",
        reason: "orchestration_dispatch_failed",
      }),
    );
    let attempts = 0;
    const result = yield* Effect.result(
      retryAmbiguousTrackedDispatch(
        Effect.sync(() => {
          attempts += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(new ThreadCliError({ operation: "live send dispatch", cause: "rejected" })),
          ),
        ),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(attempts, 1);
  }),
);

it("rejects only pending standalone waits for the current thread", () => {
  const waitHandle = {
    kind: "wait-handle" as const,
    environmentId: EnvironmentId.make("env-runner"),
    threadId: ThreadId.make("thread-runner"),
    messageId: MessageId.make("message-wait"),
  };
  assert.isTrue(
    isPendingCurrentThreadWait(waitHandle, { kind: "timed-out", waitHandle }, "thread-runner"),
  );
  assert.isFalse(
    isPendingCurrentThreadWait(
      waitHandle,
      {
        kind: "interrupted",
        environmentId: EnvironmentId.make("env-runner"),
        threadId: ThreadId.make("thread-runner"),
        messageId: MessageId.make("message-wait"),
      },
      "thread-runner",
    ),
  );
  assert.isFalse(
    isPendingCurrentThreadWait(waitHandle, { kind: "timed-out", waitHandle }, "thread-other"),
  );
});

const shellThread = (id: string) => ({ id: ThreadId.make(id) }) as OrchestrationV2ThreadShell;

const activity = (id: string, summary: string, createdAt: string) =>
  ({
    id,
    kind: "tool.completed",
    tone: "tool",
    summary,
    payload: { preserved: id },
    runId: "turn-presentation",
    createdAt,
  }) as ThreadCliActivity;

const requestActivity = (
  id: string,
  kind: "approval.requested" | "approval.resolved" | "user-input.requested" | "user-input.resolved",
  requestId: string,
  summary: string,
  createdAt: string,
) =>
  ({
    ...activity(id, summary, createdAt),
    kind,
    tone: "approval",
    payload: { requestId },
  }) as ThreadCliActivity;

const runnerSource = () => {
  const rawThread = {
    id: ThreadId.make("thread-runner"),
    projectId: "project-runner",
    title: "Runner thread",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    updatedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
    branch: "main",
    worktreePath: null,
    providerInstanceId: "codex",
    activeProviderThreadId: null,
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    snoozedUntil: null,
    settledOverride: null,
    settledAt: null,
  };
  const thread = rawThread as never;
  const limits: number[] = [];
  return {
    limits,
    source: {
      descriptor: { environmentId: EnvironmentId.make("env-runner") },
      home: "/tmp/lastcode-home",
      shell: {
        projects: [
          {
            id: "project-runner",
            title: "Runner project",
            workspaceRoot: "/tmp/workspace",
          },
        ],
        threads: [thread],
      },
      getThread: (_threadId: ThreadId, limit: number) => {
        limits.push(limit);
        return Effect.succeed({
          thread: rawThread,
          messages: [],
          turnItems: [],
          runs: [],
          providerThreads: [],
          providerSessions: [],
        } as never);
      },
    } as unknown as ThreadReadSource,
  };
};

it("resolves exact ids before unique prefixes", () => {
  const exact = shellThread("abc");
  const longer = shellThread("abc-123");
  assert.deepStrictEqual(resolveThreadTarget([exact, longer], "abc"), {
    kind: "resolved",
    thread: exact,
  });
  assert.deepStrictEqual(resolveThreadTarget([exact, longer], "abc-1"), {
    kind: "resolved",
    thread: longer,
  });
});

it("fails closed with candidates for ambiguous prefixes and reports not found", () => {
  assert.deepStrictEqual(resolveThreadTarget([shellThread("aaa-1"), shellThread("aaa-2")], "aaa"), {
    kind: "ambiguous",
    identifier: "aaa",
    candidates: ["aaa-1", "aaa-2"],
  });
  assert.deepStrictEqual(resolveThreadTarget([shellThread("aaa-1")], "missing"), {
    kind: "not-found",
    identifier: "missing",
  });
  assert.deepStrictEqual(resolveThreadTarget([shellThread("aaa-1")], "   "), {
    kind: "not-found",
    identifier: "",
  });
});

it("caps ambiguous candidates deterministically and reports the original count", () => {
  const threads = Array.from({ length: THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS + 5 }, (_, index) =>
    shellThread(`shared-${String(index).padStart(2, "0")}`),
  ).toReversed();
  const result = resolveThreadTarget(threads, "shared-");
  assert.deepStrictEqual(result, {
    kind: "ambiguous",
    identifier: "shared-",
    candidates: Array.from(
      { length: THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS },
      (_, index) => `shared-${String(index).padStart(2, "0")}`,
    ),
    candidatesTruncated: true,
    originalCandidateCount: THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS + 5,
  });
});

it("validates the conservative read window", () => {
  assert.strictEqual(validateThreadTurnLimit(1), 1);
  assert.strictEqual(validateThreadTurnLimit(20), 20);
  assert.throws(() => validateThreadTurnLimit(0));
  assert.throws(() => validateThreadTurnLimit(21));
  assert.throws(() => validateThreadTurnLimit(1.5));
});

it.effect("runs current, list, and bounded read outputs and rejects missing current context", () =>
  Effect.gen(function* () {
    const { source, limits } = runnerSource();
    const current = yield* currentThreadOutput(source, {
      threadId: "thread-runner",
      home: "/tmp/lastcode-home",
    });
    const list = yield* listThreadsOutput(source);
    const read = yield* readThreadOutput(source, "thread-r", 7);
    const missing = yield* Effect.result(currentThreadOutput(source, {}));

    assert.strictEqual(current.kind, "current");
    assert.strictEqual(current.threadId, "thread-runner");
    assert.strictEqual(list.kind, "list");
    assert.strictEqual(list.threads[0]?.threadId, "thread-runner");
    assert.isFalse("threadsTruncated" in list);
    assert.isFalse("originalThreadCount" in list);
    assert.strictEqual(read.kind, "read");
    assert.deepStrictEqual(limits, [1, 7]);
    assert.strictEqual(missing._tag, "Failure");
  }),
);

it.effect("caps thread lists deterministically and reports truncation", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    const originalThreadCount = THREAD_LIST_MAX_RESULTS + 5;
    const threads = Array.from({ length: originalThreadCount }, (_, index) => ({
      ...source.shell.threads[0]!,
      id: ThreadId.make(`thread-${String(index).padStart(2, "0")}`),
      updatedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
    })).toReversed();
    const list = yield* listThreadsOutput({
      ...source,
      shell: { ...source.shell, threads },
    });

    assert.strictEqual(list.threads.length, THREAD_LIST_MAX_RESULTS);
    assert.deepStrictEqual(
      list.threads.map(({ threadId }) => threadId),
      Array.from(
        { length: THREAD_LIST_MAX_RESULTS },
        (_, index) => `thread-${String(index).padStart(2, "0")}`,
      ),
    );
    assert.strictEqual(list.threadsTruncated, true);
    assert.strictEqual(list.originalThreadCount, originalThreadCount);
  }),
);

it("keeps V2 requests, durable queued runs, background work and settlement visible", () => {
  const { source } = runnerSource();
  const base = source.shell.threads[0]!;
  const now = "2026-06-01T00:00:00.000Z";
  assert.equal(
    threadLifecycle({ ...base, pendingRuntimeRequest: { kind: "approval" } as never }, { now }),
    "pending-input",
  );
  for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const)
    assert.equal(threadLifecycle({ ...base, status }, { now }), "working");
  assert.equal(
    threadLifecycle({ ...base, pendingBackgroundTasks: [{ kind: "monitor" } as never] }, { now }),
    "working",
  );
  assert.equal(threadLifecycle({ ...base, settledOverride: "settled" }, { now }), "settled");
  assert.equal(threadLifecycle(base, { now }), "active");
});

it("expires snooze and reveals errors or completion newer than the snooze", () => {
  const base = {
    ...runnerSource().source.shell.threads[0]!,
    snoozedUntil: DateTime.makeUnsafe("2026-06-02T00:00:00.000Z"),
    snoozedAt: DateTime.makeUnsafe("2026-05-31T12:00:00.000Z"),
  };
  const now = "2026-06-01T00:00:00.000Z";
  assert.equal(threadLifecycle(base, { now }), "snoozed");
  assert.equal(
    threadLifecycle(
      { ...base, snoozedUntil: DateTime.makeUnsafe("2026-05-31T00:00:00.000Z") },
      { now },
    ),
    "active",
  );
  assert.equal(threadLifecycle({ ...base, status: "running" }, { now }), "snoozed");
  assert.equal(
    threadLifecycle(
      { ...base, status: "failed", updatedAt: DateTime.makeUnsafe("2026-06-01T01:00:00.000Z") },
      { now },
    ),
    "active",
  );
  assert.equal(
    threadLifecycle(
      { ...base, status: "failed", updatedAt: DateTime.makeUnsafe("2026-05-31T11:00:00.000Z") },
      { now },
    ),
    "snoozed",
  );
  assert.equal(
    threadLifecycle(
      {
        ...base,
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-06-01T01:00:00.000Z"),
      },
      { now },
    ),
    "active",
  );
});

it("keeps recent transcript text within the presentation budget without dropping metadata", () => {
  const message = (id: string, text: string): ThreadCliMessage => ({
    id: id as ThreadCliMessage["id"],
    role: "assistant",
    text,
    runId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z" as ThreadCliMessage["createdAt"],
    updatedAt: "2026-01-01T00:00:00.000Z" as ThreadCliMessage["updatedAt"],
  });
  const result = boundTranscriptMessages([
    message("old", "o".repeat(100)),
    message("new", "n".repeat(THREAD_TRANSCRIPT_MAX_CHARS)),
  ]);
  assert.strictEqual(result.textTruncated, true);
  assert.strictEqual(result.originalTextChars, THREAD_TRANSCRIPT_MAX_CHARS + 100);
  assert.strictEqual(result.messages[0]?.id, "old");
  assert.strictEqual(result.messages[0]?.text, "");
  assert.strictEqual(result.messages[1]?.text.length, THREAD_TRANSCRIPT_MAX_CHARS);
});

it("bounds huge activity summaries and preserves their metadata", () => {
  const huge = activity(
    "activity-huge",
    `prefix-${"s".repeat(THREAD_TRANSCRIPT_MAX_CHARS)}`,
    "2026-01-03T00:00:00.000Z",
  );
  const result = boundThreadPresentation([], [huge]);
  assert.strictEqual(result.activities[0]?.summary.length, THREAD_TRANSCRIPT_MAX_CHARS);
  assert.match(result.activities[0]?.summary ?? "", /^s+$/);
  assert.strictEqual(result.textTruncated, true);
  assert.strictEqual(result.originalTextChars, huge.summary.length);
  assert.deepStrictEqual(
    {
      id: result.activities[0]?.id,
      kind: result.activities[0]?.kind,
      tone: result.activities[0]?.tone,
      payload: result.activities[0]?.payload,
      runId: result.activities[0]?.runId,
      createdAt: result.activities[0]?.createdAt,
    },
    {
      id: huge.id,
      kind: huge.kind,
      tone: huge.tone,
      payload: huge.payload,
      runId: huge.runId,
      createdAt: huge.createdAt,
    },
  );
});

it("caps activity records to the most recent entries while retaining their original order", () => {
  const activities = Array.from({ length: THREAD_ACTIVITY_MAX_RESULTS + 5 }, (_, index) =>
    activity(
      `activity-${index}`,
      "x",
      `2026-01-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    ),
  );
  const result = boundThreadPresentation([], activities);
  assert.strictEqual(result.activities.length, THREAD_ACTIVITY_MAX_RESULTS);
  assert.strictEqual(result.activities[0]?.id, "activity-5");
  assert.strictEqual(result.activities.at(-1)?.id, `activity-${activities.length - 1}`);
  assert.strictEqual(result.activitiesTruncated, true);
  assert.strictEqual(result.originalActivityCount, activities.length);
  assert.strictEqual(result.textTruncated, true);
  assert.strictEqual(result.originalTextChars, activities.length);
});

it("retains an old unresolved request before filling the activity cap with recent entries", () => {
  const pending = requestActivity(
    "approval-pending",
    "approval.requested",
    "request-pending",
    "Approval required",
    "2025-12-31T00:00:00.000Z",
  );
  const pendingInput = requestActivity(
    "user-input-pending",
    "user-input.requested",
    "input-pending",
    "Input required",
    "2025-12-31T00:30:00.000Z",
  );
  const resolvedRequest = requestActivity(
    "user-input-closed",
    "user-input.requested",
    "request-closed",
    "Input required",
    "2025-12-31T01:00:00.000Z",
  );
  const resolution = requestActivity(
    "user-input-resolution",
    "user-input.resolved",
    "request-closed",
    "Input received",
    "2025-12-31T02:00:00.000Z",
  );
  const recent = Array.from({ length: THREAD_ACTIVITY_MAX_RESULTS + 5 }, (_, index) =>
    activity(
      `activity-${index}`,
      "x",
      `2026-01-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    ),
  );

  const result = boundThreadPresentation(
    [],
    [pending, pendingInput, resolvedRequest, resolution, ...recent],
  );

  assert.strictEqual(result.activities.length, THREAD_ACTIVITY_MAX_RESULTS);
  assert.strictEqual(result.activities[0]?.id, pending.id);
  assert.strictEqual(result.activities[1]?.id, pendingInput.id);
  assert.strictEqual(result.activities[2]?.id, "activity-7");
  assert.strictEqual(result.activities.at(-1)?.id, `activity-${recent.length - 1}`);
  assert.strictEqual(
    result.activities.some(({ id }) => id === resolvedRequest.id),
    false,
  );
  assert.strictEqual(
    result.activities.some(({ id }) => id === resolution.id),
    false,
  );
  assert.strictEqual(result.activitiesTruncated, true);
  assert.strictEqual(result.originalActivityCount, recent.length + 4);
});

it("reserves presentation text for an old unresolved request explanation", () => {
  const pending = requestActivity(
    "approval-pending",
    "approval.requested",
    "request-pending",
    "Approval required",
    "2025-12-31T00:00:00.000Z",
  );
  const recent = activity(
    "activity-new",
    "n".repeat(THREAD_TRANSCRIPT_MAX_CHARS),
    "2026-01-01T00:00:00.000Z",
  );

  const result = boundThreadPresentation([], [pending, recent]);

  assert.strictEqual(result.activities[0]?.summary, pending.summary);
  assert.strictEqual(
    result.activities[1]?.summary.length,
    THREAD_TRANSCRIPT_MAX_CHARS - pending.summary.length,
  );
  assert.match(result.activities[1]?.summary ?? "", /^n+$/);
  assert.strictEqual(
    result.activities.reduce((total, item) => total + item.summary.length, 0),
    THREAD_TRANSCRIPT_MAX_CHARS,
  );
  assert.strictEqual(result.textTruncated, true);
  assert.strictEqual(result.activitiesTruncated, false);
});

it("shares one text budget across messages and activities, favoring newer content", () => {
  const oldMessage = {
    id: "message-old",
    role: "assistant",
    text: `old-${"m".repeat(39_996)}`,
    runId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ThreadCliMessage;
  const newerActivity = activity(
    "activity-new",
    `new-${"a".repeat(39_996)}`,
    "2026-01-02T00:00:00.000Z",
  );
  const result = boundThreadPresentation([oldMessage], [newerActivity]);
  assert.strictEqual(result.activities[0]?.summary, newerActivity.summary);
  assert.strictEqual(result.messages[0]?.text.length, 24_000);
  assert.match(result.messages[0]?.text ?? "", /^m+$/);
  assert.strictEqual(
    (result.messages[0]?.text.length ?? 0) + (result.activities[0]?.summary.length ?? 0),
    THREAD_TRANSCRIPT_MAX_CHARS,
  );
  assert.strictEqual(result.textTruncated, true);
  assert.strictEqual(result.activitiesTruncated, false);
});

it.effect(
  "issues the read-only scope and revokes it after success, failure, and timeout failure",
  () =>
    Effect.gen(function* () {
      const issuedScopes: string[][] = [];
      const revoked: string[] = [];
      const auth = {
        issueSession: ({ scopes }: { scopes: string[] }) => {
          issuedScopes.push(scopes);
          return Effect.succeed({ sessionId: `session-${issuedScopes.length}`, token: "token" });
        },
        revokeSession: (sessionId: string) => {
          revoked.push(sessionId);
          return Effect.void;
        },
      } as never;

      yield* withReadSession(auth, () => Effect.succeed("ok"));
      yield* Effect.result(withReadSession(auth, () => Effect.fail("failed")));
      yield* Effect.result(
        withReadSession(auth, () => Effect.fail({ _tag: "TimeoutException" as const })),
      );

      assert.deepStrictEqual(issuedScopes, [
        ["orchestration:read"],
        ["orchestration:read"],
        ["orchestration:read"],
      ]);
      assert.deepStrictEqual(revoked, ["session-1", "session-2", "session-3"]);
    }),
);

it.effect("prepares and dispatches an exact accepted send using the target thread settings", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    const dispatched: unknown[] = [];
    const sendSource: ThreadSendSource = {
      descriptor: source.descriptor,
      shell: source.shell,
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 42 });
      },
    };
    const result = yield* sendThreadOutput(sendSource, {
      identifier: "thread-r",
      message: "  Tell me the status.  ",
      commandId: CommandId.make("command-send"),
      messageId: MessageId.make("message-send"),
      sourceThreadId: ThreadId.make("thread-source"),
    });

    assert.deepStrictEqual(result, {
      kind: "accepted",
      environmentId: "env-runner",
      threadId: "thread-runner",
      messageId: "message-send",
    });
    assert.deepStrictEqual(dispatched, [
      {
        type: "message.dispatch",
        commandId: "command-send",
        threadId: "thread-runner",
        messageId: "message-send",
        text: "Tell me the status.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        senderThreadId: "thread-source",
      },
    ]);
  }),
);

it.effect(
  "delivers a native steer to the observed active run without requesting a selection change",
  () =>
    Effect.gen(function* () {
      const { source } = runnerSource();
      const dispatched: unknown[] = [];
      yield* sendThreadOutput(
        {
          descriptor: source.descriptor,
          shell: {
            ...source.shell,
            threads: source.shell.threads.map((thread) => ({
              ...thread,
              activeRunId: RunId.make("run-active"),
            })),
          },
          dispatch: (command) => Effect.sync(() => dispatched.push(command)),
        },
        {
          identifier: "thread-runner",
          message: "Pause after your current operation.",
          commandId: CommandId.make("command-native-steer"),
          messageId: MessageId.make("message-native-steer"),
          steerNative: true,
        },
      );
      assert.deepStrictEqual(dispatched, [
        {
          type: "message.dispatch",
          commandId: "command-native-steer",
          threadId: "thread-runner",
          messageId: "message-native-steer",
          text: "Pause after your current operation.",
          attachments: [],
          dispatchMode: { type: "steer_active_native", targetRunId: "run-active" },
          createdBy: "user",
          creationSource: "server",
        },
      ]);
    }),
);

it.effect("rejects a native steer to an idle thread without creating a queued turn", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    let dispatchCount = 0;
    const result = yield* Effect.result(
      sendThreadOutput(
        {
          descriptor: source.descriptor,
          shell: source.shell,
          dispatch: () =>
            Effect.sync(() => {
              dispatchCount += 1;
            }),
        },
        {
          identifier: "thread-runner",
          message: "Pause after your current operation.",
          commandId: CommandId.make("command-idle-steer"),
          messageId: MessageId.make("message-idle-steer"),
          steerNative: true,
        },
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(dispatchCount, 0);
  }),
);

it.effect("does not mark a send to the current thread as cross-thread", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    const dispatched: unknown[] = [];
    yield* sendThreadOutput(
      {
        descriptor: source.descriptor,
        shell: source.shell,
        dispatch: (command) => Effect.sync(() => dispatched.push(command)),
      },
      {
        identifier: "thread-runner",
        message: "status",
        commandId: CommandId.make("command-self-send"),
        messageId: MessageId.make("message-self-send"),
        sourceThreadId: ThreadId.make("thread-runner"),
      },
    );

    assert.notProperty(dispatched[0] as object, "senderThreadId");
  }),
);

it.effect("uses the same durable message identity for tracked and untracked sends", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    const dispatched: unknown[] = [];
    const sendSource: ThreadSendSource = {
      descriptor: source.descriptor,
      shell: source.shell,
      dispatch: (command) => Effect.sync(() => dispatched.push(command)),
    };
    const input = {
      identifier: "thread-runner",
      message: "status",
      commandId: CommandId.make("command-tracked"),
      messageId: MessageId.make("message-tracked"),
    };
    yield* sendThreadOutput(sendSource, input);
    yield* sendThreadOutput(sendSource, { ...input, trackRequestCorrelation: true });
    assert.deepStrictEqual(dispatched[0], dispatched[1]);
  }),
);

it.effect("rejects waiting on the current thread before dispatch", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    let dispatchCount = 0;
    const result = yield* Effect.result(
      sendThreadOutput(
        {
          descriptor: source.descriptor,
          shell: source.shell,
          dispatch: () => {
            dispatchCount += 1;
            return Effect.void;
          },
        },
        {
          identifier: "thread-runner",
          message: "pause for update",
          commandId: CommandId.make("command-self-wait"),
          messageId: MessageId.make("message-self-wait"),
          trackRequestCorrelation: true,
          rejectWaitForThreadId: ThreadId.make("thread-runner"),
        },
      ),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(result._tag === "Failure" ? result.failure._tag : "", "ThreadCliError");
    assert.strictEqual(dispatchCount, 0);
  }),
);

it.effect("rejects blank, missing, ambiguous, and oversized sends before dispatch", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    let dispatchCount = 0;
    const sendSource: ThreadSendSource = {
      descriptor: source.descriptor,
      shell: {
        ...source.shell,
        threads: [
          source.shell.threads[0]!,
          { ...source.shell.threads[0]!, id: ThreadId.make("thread-rival") },
        ],
      },
      dispatch: () => {
        dispatchCount += 1;
        return Effect.succeed({ sequence: 1 });
      },
    };
    const input = {
      message: "hello",
      commandId: CommandId.make("command-send-invalid"),
      messageId: MessageId.make("message-send-invalid"),
    };

    const blank = yield* Effect.result(
      sendThreadOutput(sendSource, { ...input, identifier: "   " }),
    );
    const missing = yield* Effect.result(
      sendThreadOutput(sendSource, { ...input, identifier: "missing" }),
    );
    const ambiguous = yield* Effect.result(
      sendThreadOutput(sendSource, { ...input, identifier: "thread-r" }),
    );
    const oversized = yield* Effect.result(
      sendThreadOutput(sendSource, {
        ...input,
        identifier: "thread-runner",
        message: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
      }),
    );

    assert.strictEqual(blank._tag, "Failure");
    assert.strictEqual(blank._tag === "Failure" ? blank.failure._tag : "", "ThreadSendTargetError");
    assert.strictEqual(missing._tag, "Failure");
    assert.strictEqual(ambiguous._tag, "Failure");
    if (ambiguous._tag === "Failure" && ambiguous.failure._tag === "ThreadSendTargetError") {
      assert.deepStrictEqual(ambiguous.failure.candidates, ["thread-rival", "thread-runner"]);
    }
    assert.strictEqual(oversized._tag, "Failure");
    assert.strictEqual(
      oversized._tag === "Failure" ? oversized.failure._tag : "",
      "ThreadSendMessageError",
    );
    assert.strictEqual(dispatchCount, 0);
  }),
);

it.effect("does not report acceptance when authoritative dispatch rejects the send", () =>
  Effect.gen(function* () {
    const { source } = runnerSource();
    const result = yield* Effect.result(
      sendThreadOutput(
        {
          descriptor: source.descriptor,
          shell: source.shell,
          dispatch: () =>
            Effect.fail(
              new ThreadCliError({ operation: "test dispatch rejection", cause: "rejected" }),
            ),
        },
        {
          identifier: "thread-runner",
          message: "hello",
          commandId: CommandId.make("command-send-rejected"),
          messageId: MessageId.make("message-send-rejected"),
        },
      ),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "ThreadCliError");
    }
  }),
);

it.effect("issues read and operate scopes and revokes send sessions on every exit path", () =>
  Effect.gen(function* () {
    const issuedScopes: string[][] = [];
    const revoked: string[] = [];
    const auth = {
      issueSession: ({ scopes }: { scopes: string[] }) => {
        issuedScopes.push(scopes);
        return Effect.succeed({ sessionId: `send-${issuedScopes.length}`, token: "token" });
      },
      revokeSession: (sessionId: string) => {
        revoked.push(sessionId);
        return Effect.void;
      },
    } as never;

    yield* withSendSession(auth, () => Effect.succeed("ok"));
    yield* Effect.result(withSendSession(auth, () => Effect.fail("rejected")));
    yield* Effect.result(
      withSendSession(auth, () => Effect.fail({ _tag: "TimeoutException" as const })),
    );

    assert.deepStrictEqual(issuedScopes, [
      ["orchestration:read", "orchestration:operate"],
      ["orchestration:read", "orchestration:operate"],
      ["orchestration:read", "orchestration:operate"],
    ]);
    assert.deepStrictEqual(revoked, ["send-1", "send-2", "send-3"]);
  }),
);

const runThreadCli = (args: ReadonlyArray<string>) =>
  Command.runWith(threadCommand, { version: "0.0.0", renderErrors: false })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
  );

it.effect.each([
  { args: ["send", "thread-1"] },
  { args: ["send", "thread-1", "positional", "--message", "flag"] },
])("rejects missing or conflicting message sources before contacting a server: %j", ({ args }) =>
  Effect.gen(function* () {
    const error = yield* runThreadCli(args).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ThreadUsageError");
    assert.include(error.message, "Pass exactly one message");
  }),
);

it.effect("routes positional sends to MCP message validation", () =>
  Effect.gen(function* () {
    const error = yield* runThreadCli(["send", "thread-1", "   "]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ThreadUsageError");
    assert.strictEqual(error.message, "The message is empty.");
  }),
);

it.effect("retains flag-based send timeout validation", () =>
  Effect.gen(function* () {
    const error = yield* runThreadCli([
      "send",
      "thread-1",
      "--message",
      "text",
      "--timeout",
      "invalid",
    ]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SchemaError");
  }),
);

it.effect.each([
  { options: ["--steer-native"] },
  { options: ["--timeout", "1 minute"] },
])("rejects tracked-send options with the positional MCP send: %j", ({ options }) =>
  Effect.gen(function* () {
    const error = yield* runThreadCli(["send", "thread-1", "text", ...options]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ThreadUsageError");
    assert.strictEqual(error.message, "--steer-native and --timeout require --message <text>.");
  }),
);

it.effect("retains the upstream start and show subcommands", () =>
  Effect.gen(function* () {
    const startError = yield* runThreadCli(["start", ".", "text", "--provider", "codex"]).pipe(
      Effect.flip,
    );
    assert.strictEqual(startError._tag, "ThreadUsageError");
    assert.strictEqual(startError.message, "--provider and --model go together.");
    const showError = yield* runThreadCli(["show", "   "]).pipe(Effect.flip);
    assert.strictEqual(showError._tag, "ThreadUsageError");
    assert.include(showError.message, "is not a thread id");
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const git = Effect.fn("test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
  assert.strictEqual(Number(exitCode), 0, `git ${args.join(" ")}`);
});

const commitAll = (cwd: string) =>
  Effect.andThen(
    git(cwd, ["add", "."]),
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]),
  );

it.live("resolves a path inside a git worktree of the project's repository to that project", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-worktree-" });
    const repo = path.join(root, "sample");
    const worktree = path.join(root, "worktrees", "sample", "t3-8ff64c24");
    const feature = path.join(root, "wt", "feature");
    const featureWorktree = path.join(root, "worktrees", "feature", "t3-1a2b3c4d");
    yield* fileSystem.makeDirectory(path.join(repo, "pkg"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(repo, "pkg", "index.ts"), "export {};\n");
    yield* git(repo, ["init", "--quiet", "-b", "main"]);
    yield* commitAll(repo);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "t3/8ff64c24", worktree]);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "feature", feature]);
    yield* git(feature, ["worktree", "add", "--quiet", "-b", "t3/1a2b3c4d", featureWorktree]);

    const project = (id: string, workspaceRoot: string) => ({
      id: ProjectId.make(id),
      title: path.basename(workspaceRoot),
      workspaceRoot,
    });
    const sample = project("project-sample", repo);
    const featureProject = project("project-feature", feature);
    const resolveFrom = (
      projects: ReadonlyArray<ReturnType<typeof project>>,
      workingDirectory: string,
      identifier = ".",
    ) =>
      resolveProject(
        scriptedTools({ t3_project_list: [{ projects, nextCursor: null }] }).tools,
        identifier,
      ).pipe(Effect.provideService(HostProcess.WorkingDirectory, workingDirectory));

    assert.deepStrictEqual(yield* resolveFrom([sample], worktree), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], path.join(worktree, "pkg")), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], worktree, "pkg/index.ts"), sample);
    assert.deepStrictEqual(yield* resolveFrom([featureProject], featureWorktree), featureProject);
    const ambiguous = yield* Effect.flip(resolveFrom([sample, featureProject], featureWorktree));
    assert.strictEqual(ambiguous._tag, "ThreadUsageError");
    assert.include(ambiguous.message, "sample (project-sample)");
    assert.include(ambiguous.message, "feature (project-feature)");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
