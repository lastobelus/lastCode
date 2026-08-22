import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ThreadId,
  EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import {
  THREAD_TRANSCRIPT_MAX_CHARS,
  THREAD_ACTIVITY_MAX_RESULTS,
  THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS,
  THREAD_LIST_MAX_RESULTS,
  type ThreadReadSource,
  boundThreadPresentation,
  boundTranscriptMessages,
  currentThreadOutput,
  listThreadsOutput,
  readThreadOutput,
  resolveThreadTarget,
  threadLifecycle,
  validateThreadTurnLimit,
  withReadSession,
} from "./thread.ts";

const shellThread = (id: string) => ({ id: ThreadId.make(id) }) as OrchestrationThreadShell;

const activity = (id: string, summary: string, createdAt: string) =>
  ({
    id,
    kind: "tool.completed",
    tone: "tool",
    summary,
    payload: { preserved: id },
    turnId: "turn-presentation",
    createdAt,
  }) as OrchestrationThread["activities"][number];

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
  }) as OrchestrationThread["activities"][number];

const runnerSource = () => {
  const rawThread = {
    id: ThreadId.make("thread-runner"),
    projectId: "project-runner",
    title: "Runner thread",
    updatedAt: "2026-01-02T00:00:00.000Z",
    branch: "main",
    worktreePath: null,
    session: null,
    latestTurn: null,
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    backgroundLiveness: null,
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
          thread: { ...rawThread, messages: [], activities: [], latestTurn: null },
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
    assert.deepStrictEqual(limits, [7]);
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
      updatedAt: "2026-01-02T00:00:00.000Z",
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

it("keeps pending-input, working, snoozed, settled, and active lifecycle states visible", () => {
  const lifecycleThread = (overrides: Partial<OrchestrationThreadShell>) =>
    ({
      hasPendingUserInput: false,
      hasPendingApprovals: false,
      latestTurn: null,
      session: null,
      backgroundLiveness: null,
      snoozedUntil: null,
      settledOverride: null,
      settledAt: null,
      ...overrides,
    }) as OrchestrationThreadShell;
  assert.strictEqual(
    threadLifecycle(lifecycleThread({ hasPendingUserInput: true }), {
      now: "2026-06-01T00:00:00.000Z",
    }),
    "pending-input",
  );
  assert.strictEqual(
    threadLifecycle(lifecycleThread({ session: { status: "running" } as never }), {
      now: "2026-06-01T00:00:00.000Z",
    }),
    "working",
  );
  assert.strictEqual(
    threadLifecycle(lifecycleThread({ snoozedUntil: "2026-12-01T00:00:00.000Z" as never }), {
      now: "2026-06-01T00:00:00.000Z",
    }),
    "snoozed",
  );
  assert.strictEqual(
    threadLifecycle(lifecycleThread({ settledOverride: "settled" }), {
      now: "2026-06-01T00:00:00.000Z",
    }),
    "settled",
  );
  assert.strictEqual(
    threadLifecycle(lifecycleThread({}), { now: "2026-06-01T00:00:00.000Z" }),
    "active",
  );
});

it("matches effective snooze expiry, precedence, and raised-hand behavior", () => {
  const base = {
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    latestTurn: null,
    session: null,
    backgroundLiveness: null,
    snoozedUntil: "2026-06-02T00:00:00.000Z",
    snoozedAt: "2026-05-31T12:00:00.000Z",
    settledOverride: null,
    settledAt: null,
  } as unknown as OrchestrationThreadShell;
  const now = "2026-06-01T00:00:00.000Z";
  assert.strictEqual(threadLifecycle(base, { now }), "snoozed");
  assert.strictEqual(
    threadLifecycle({ ...base, snoozedUntil: "2026-05-31T00:00:00.000Z" } as never, { now }),
    "active",
  );
  assert.strictEqual(
    threadLifecycle({ ...base, hasPendingApprovals: true } as never, { now }),
    "pending-input",
  );
  assert.strictEqual(
    threadLifecycle({ ...base, session: { status: "running" } } as never, { now }),
    "snoozed",
  );
  assert.strictEqual(
    threadLifecycle(
      {
        ...base,
        session: { status: "error", updatedAt: "2026-06-01T01:00:00.000Z" },
      } as never,
      { now },
    ),
    "active",
  );
  assert.strictEqual(
    threadLifecycle(
      {
        ...base,
        session: { status: "error", updatedAt: "2026-05-31T11:00:00.000Z" },
      } as never,
      { now },
    ),
    "snoozed",
  );
  assert.strictEqual(
    threadLifecycle(
      {
        ...base,
        latestTurn: {
          state: "completed",
          completedAt: "2026-06-01T01:00:00.000Z",
        },
      } as never,
      { now },
    ),
    "active",
  );
  assert.strictEqual(
    threadLifecycle(
      {
        ...base,
        latestTurn: {
          state: "completed",
          completedAt: "2026-05-31T11:00:00.000Z",
        },
      } as never,
      { now },
    ),
    "snoozed",
  );
});

it("keeps recent transcript text within the presentation budget without dropping metadata", () => {
  const message = (id: string, text: string): OrchestrationMessage => ({
    id: id as OrchestrationMessage["id"],
    role: "assistant",
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z" as OrchestrationMessage["createdAt"],
    updatedAt: "2026-01-01T00:00:00.000Z" as OrchestrationMessage["updatedAt"],
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
      turnId: result.activities[0]?.turnId,
      createdAt: result.activities[0]?.createdAt,
    },
    {
      id: huge.id,
      kind: huge.kind,
      tone: huge.tone,
      payload: huge.payload,
      turnId: huge.turnId,
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
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as OrchestrationMessage;
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
