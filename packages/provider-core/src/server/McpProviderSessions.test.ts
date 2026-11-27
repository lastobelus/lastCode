import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops the oldest screenshot and its same-input siblings once a thread is full", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const shot = (fill: string) => ({
        content: [{ type: "image", mimeType: "image/png", data: fill.repeat(12 * 1024 * 1024) }],
      });
      const phone = { deviceId: "phone" };
      const tablet = { deviceId: "tablet" };
      const watch = { deviceId: "watch" };
      const take = (thread: ThreadId, input: unknown) =>
        sessions.takeToolResult(thread, "device_screenshot", input);

      yield* sessions.recordToolResult(threadId, "device_screenshot", phone, shot("A"));
      yield* sessions.recordToolResult(threadId, "device_screenshot", tablet, shot("B"));
      yield* sessions.recordToolResult(threadId, "device_screenshot", watch, shot("C"));
      assert.isUndefined(yield* take(threadId, phone));
      assert.deepEqual(yield* take(threadId, tablet), shot("B"));
      assert.deepEqual(yield* take(threadId, watch), shot("C"));

      // Keeping the second phone shot alone would hand it to the first phone call.
      const siblings = ThreadId.make("thread-tool-results-siblings");
      yield* sessions.recordToolResult(siblings, "device_screenshot", phone, shot("A"));
      yield* sessions.recordToolResult(siblings, "device_screenshot", tablet, shot("B"));
      yield* sessions.recordToolResult(siblings, "device_screenshot", phone, shot("C"));
      assert.isUndefined(yield* take(siblings, phone));
      assert.deepEqual(yield* take(siblings, tablet), shot("B"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Old" }),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId);
      yield* sessions.clearToolResults(threadId);
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Late from turn 1" }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});

describe("McpProviderSessions approval requests", () => {
  const threadId = ThreadId.make("thread-approval-requests");
  const pushHooks = { branch: "tools", files: [".husky/pre-push"], commands: [] };
  const makeSession = (providerSessionId: string) => ({
    environmentId: EnvironmentId.make("env-approval-requests"),
    threadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer token",
    browserToolsAvailable: false,
  });

  it.effect("keeps what a thread was asked until it is answered, per thread and message", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const asked = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });

      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
      // Showing the request does not end it.
      assert.isDefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools!"));
      assert.isUndefined(
        yield* sessions.findApprovalRequest(ThreadId.make("another-thread"), "Push tools?"),
      );

      yield* sessions.forgetApprovalRequest(threadId, asked);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("an answer forgets only the request it answers", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      // Two calls asking the same thing are answered one at a time, each once.
      const first = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      const second = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.forgetApprovalRequest(threadId, first);
      yield* sessions.forgetApprovalRequest(threadId, first);
      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.forgetApprovalRequest(threadId, second);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request that ends after its session was replaced leaves the new session's", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const earlier = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.set(makeSession("provider-session-2"));
      yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?", pushHooks });

      yield* sessions.forgetApprovalRequest(threadId, earlier);
      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("keeps the person's answer with the requests that ask that message, once", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const tools = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
        state: "digest-1 1",
      });
      const docs = yield* sessions.recordApprovalRequest(threadId, { message: "Push docs?" });
      const elsewhere = yield* sessions.recordApprovalRequest(ThreadId.make("another-thread"), {
        message: "Push tools?",
      });

      yield* sessions.answerApprovalRequests(threadId, "Push tools?", true);
      // The first answer stands.
      yield* sessions.answerApprovalRequests(threadId, "Push tools?", false);
      // Asked after the answer: not answered by it.
      const later = yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?" });

      assert.deepInclude(yield* sessions.takeApprovalRequest(threadId, tools), {
        approved: true,
        state: "digest-1 1",
      });
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, tools));
      assert.notProperty(yield* sessions.takeApprovalRequest(threadId, docs), "approved");
      assert.notProperty(yield* sessions.takeApprovalRequest(threadId, later), "approved");
      assert.notProperty(
        yield* sessions.takeApprovalRequest(ThreadId.make("another-thread"), elsewhere),
        "approved",
      );
      // A request is taken from its own thread only.
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, elsewhere));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("an answer does not outlive the thread's session", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const asked = yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?" });
      yield* sessions.answerApprovalRequests(threadId, "Push tools?", true);
      yield* sessions.set(makeSession("provider-session-2"));
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, asked));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("knows which provider instances show T3 Code's own requests", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const codex = ProviderInstanceId.make("codex");
      assert.isFalse(yield* sessions.areApprovalRequestsShown(codex));
      yield* sessions.showsApprovalRequests(codex);
      assert.isTrue(yield* sessions.areApprovalRequestsShown(codex));
      assert.isFalse(yield* sessions.areApprovalRequestsShown(ProviderInstanceId.make("other")));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops what was asked when the thread's session ends", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?", pushHooks });
      yield* sessions.clear(threadId);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});

it.effect(
  "freezes native origins across reused turns and rejects foreign, missing and ended origins",
  () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make("thread");
      const config = {
        threadId,
        environmentId: EnvironmentId.make("env"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "credential",
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: true,
      };
      yield* sessions.set(config);
      const a = { runId: RunId.make("a"), attemptId: RunAttemptId.make("a") };
      const b = { runId: RunId.make("b"), attemptId: RunAttemptId.make("b") };
      const origin = (turnId: string) => ({
        provider: "codex" as const,
        nativeThreadId: "native",
        nativeTurnId: turnId,
      });
      const meta = (turnId: string, nativeThreadId = "native") => ({
        "x-codex-turn-metadata": { thread_id: nativeThreadId, turn_id: turnId },
      });
      const lookup = (metadata: unknown, authorizationHeader = config.authorizationHeader) =>
        sessions.resolveExecution({
          threadId,
          providerSessionId: config.providerSessionId,
          authorizationHeader,
          metadata,
        });
      const release = yield* sessions.beginCodexTurn(threadId, "native");
      const early = yield* lookup(meta("a")).pipe(Effect.forkScoped);
      yield* sessions.registerExecution(threadId, origin("a"), a);
      yield* release;
      expect(yield* Fiber.join(early)).toEqual(a);
      const frozen = yield* lookup(meta("a"));
      yield* sessions.registerExecution(threadId, origin("b"), b);
      yield* sessions.registerExecution(threadId, origin("a"), b);
      expect(yield* lookup(meta("a"))).toEqual(a);
      expect(yield* lookup(meta("b"))).toEqual(b);
      expect(yield* lookup(meta("a", "foreign"))).toBeUndefined();
      expect(yield* lookup(meta("unknown"))).toBeUndefined();
      expect(yield* lookup({})).toBeUndefined();
      expect(McpProviderSessions.hasNativeMcpMetadata({})).toBe(false);
      expect(McpProviderSessions.hasNativeMcpMetadata({ unrelated: true })).toBe(false);
      for (const malformed of [
        { "x-codex-turn-metadata": null },
        { "x-codex-turn-metadata": { thread_id: "native", turn_id: "" } },
        { "claudecode/toolUseId": null },
        { "claudecode/toolUseId": " " },
        { ...meta("a"), "claudecode/toolUseId": null },
      ]) {
        expect(McpProviderSessions.hasNativeMcpMetadata(malformed)).toBe(true);
        expect(yield* lookup(malformed)).toBeUndefined();
      }
      expect(yield* lookup(meta("a"), "Bearer foreign")).toBeUndefined();
      yield* sessions.endExecution(threadId, a);
      expect(yield* lookup(meta("a"))).toBeUndefined();
      yield* sessions.registerExecution(threadId, origin("a"), b);
      expect(yield* lookup(meta("a"))).toBeUndefined();
      expect(frozen).toEqual(a);
      expect(yield* lookup(meta("b"))).toEqual(b);
      const toolOrigin = (id: string) => ({ provider: "claude" as const, toolUseId: id });
      const toolMeta = (id: string) => ({ "claudecode/toolUseId": id });
      for (let index = 0; index < 4100; index++) {
        const completed = {
          runId: RunId.make(`completed-${index}`),
          attemptId: RunAttemptId.make(`completed-${index}`),
        };
        yield* sessions.registerExecution(threadId, toolOrigin(`tool-${index}`), completed);
        yield* sessions.endExecution(threadId, completed);
      }
      const c = { runId: RunId.make("c"), attemptId: RunAttemptId.make("c") };
      yield* sessions.registerExecution(threadId, toolOrigin("fresh"), c);
      expect(yield* lookup(toolMeta("fresh"))).toEqual(c);
      expect(yield* lookup(meta("b"))).toEqual(b);
      expect(yield* lookup(toolMeta("tool-0"))).toBeUndefined();
      expect(yield* lookup(meta("a"))).toBeUndefined();
      expect(yield* lookup({})).toBeUndefined();
      yield* sessions.registerExecution(threadId, toolOrigin("tool-4099"), c);
      expect(yield* lookup(toolMeta("tool-4099"))).toBeUndefined();
      yield* sessions.set(config);
      expect(yield* lookup(toolMeta("fresh"))).toEqual(c);
      yield* sessions.registerExecution(threadId, toolOrigin("tool-4099"), c);
      expect(yield* lookup(toolMeta("tool-4099"))).toBeUndefined();
      // A credential identity change resets both live bindings and retained ended keys.
      yield* sessions.set({ ...config, providerSessionId: "replacement-credential" });
      expect(yield* lookup(meta("b"))).toBeUndefined();
      yield* sessions.set(config);
      yield* sessions.registerExecution(threadId, toolOrigin("tool-4099"), c);
      expect(yield* lookup(toolMeta("tool-4099"))).toEqual(c);
      yield* sessions.endExecution(threadId, c);
      yield* sessions.clear(threadId);
      expect(yield* lookup(toolMeta("tool-4099"))).toBeUndefined();
      yield* sessions.set(config);
      yield* sessions.registerExecution(threadId, toolOrigin("tool-4099"), b);
      expect(yield* lookup(toolMeta("tool-4099"))).toEqual(b);
      expect(yield* lookup(meta("b"))).toBeUndefined();
      yield* sessions.set({
        ...config,
        providerInstanceId: ProviderInstanceId.make("replacement-provider"),
      });
      expect(yield* lookup(toolMeta("tool-4099"))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(McpProviderSessions.layer)),
);

it.effect("retains more than 4096 live tool origins and ends native children independently", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const threadId = ThreadId.make("many-live-origins");
    const config = {
      threadId,
      environmentId: EnvironmentId.make("env"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      providerSessionId: "credential",
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    };
    yield* sessions.set(config);
    const a = { runId: RunId.make("a"), attemptId: RunAttemptId.make("a") };
    const origin = (toolUseId: string) => ({ provider: "claude" as const, toolUseId });
    const lookup = (toolUseId: string) =>
      sessions.resolveExecution({
        threadId,
        providerSessionId: config.providerSessionId,
        authorizationHeader: config.authorizationHeader,
        metadata: { "claudecode/toolUseId": toolUseId },
      });
    for (let index = 0; index < 4100; index++) {
      yield* sessions.registerExecution(threadId, origin(`live-${index}`), a);
    }
    expect(yield* lookup("live-0")).toEqual(a);
    expect(yield* lookup("live-4099")).toEqual(a);
    yield* sessions.registerExecution(threadId, origin("child-a"), a, "native-child-a");
    yield* sessions.registerExecution(threadId, origin("child-b"), a, "native-child-b");
    yield* sessions.endExecution(threadId, a);
    expect(yield* lookup("live-0")).toBeUndefined();
    expect(yield* lookup("live-4099")).toBeUndefined();
    const childA = (yield* lookup("child-a"))!;
    const childB = (yield* lookup("child-b"))!;
    expect(childA).toEqual(a);
    expect(childB).toEqual(a);
    yield* sessions.endExecution(threadId, a, "native-child-a");
    expect(yield* lookup("child-a")).toBeUndefined();
    expect(yield* lookup("child-b")).toEqual(a);
    yield* sessions.registerExecution(threadId, origin("child-a"), a, "native-child-b");
    expect(yield* lookup("child-a")).toBeUndefined();
    yield* sessions.endExecution(threadId, a, "native-child-b");
    expect(yield* lookup("child-b")).toBeUndefined();
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("isolates known pending Codex children and releases cancelled credential waits", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const threadId = ThreadId.make("pending-children");
    const config = {
      threadId,
      environmentId: EnvironmentId.make("env"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "credential",
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    };
    yield* sessions.set(config);
    const execution = { runId: RunId.make("original"), attemptId: RunAttemptId.make("original") };
    const pending = Effect.fnUntraced(function* (nativeThreadId: string) {
      const done = yield* Deferred.make<void>();
      const fiber = yield* sessions
        .resolveExecution({
          threadId,
          providerSessionId: config.providerSessionId,
          authorizationHeader: config.authorizationHeader,
          metadata: { "x-codex-turn-metadata": { thread_id: nativeThreadId, turn_id: "turn" } },
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(done, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      return { done, fiber };
    });
    const rootRelease = yield* sessions.beginCodexTurn(threadId, "root");
    const releaseA = yield* sessions.beginCodexTurn(threadId, "child-a");
    const releaseB = yield* sessions.beginCodexTurn(threadId, "child-b");
    const a = yield* pending("child-a");
    const b = yield* pending("child-b");
    expect(yield* Deferred.isDone(a.done)).toBe(false);
    expect(yield* Deferred.isDone(b.done)).toBe(false);
    yield* rootRelease;
    yield* sessions.registerExecution(
      threadId,
      { provider: "codex", nativeThreadId: "root", nativeTurnId: "turn" },
      execution,
    );
    expect(yield* Deferred.isDone(a.done)).toBe(false);
    expect(yield* Deferred.isDone(b.done)).toBe(false);
    yield* sessions.registerExecution(
      threadId,
      { provider: "codex", nativeThreadId: "child-a", nativeTurnId: "turn" },
      execution,
      "child-a",
    );
    const resolved = yield* Fiber.join(a.fiber);
    expect(resolved).toMatchObject(execution);
    yield* releaseA;
    yield* releaseA;
    expect(yield* Deferred.isDone(b.done)).toBe(false);
    yield* releaseB;
    expect(yield* Fiber.join(b.fiber)).toBeUndefined();
    const releaseClear = yield* sessions.beginCodexTurn(threadId, "clear");
    const cleared = yield* pending("clear");
    yield* sessions.clear(threadId);
    expect(yield* Fiber.join(cleared.fiber)).toBeUndefined();
    expect(yield* Fiber.join((yield* pending("child-a")).fiber)).toBeUndefined();
    yield* sessions.set(config);
    const releaseReplace = yield* sessions.beginCodexTurn(threadId, "replace");
    const replaced = yield* pending("replace");
    yield* sessions.set({ ...config, providerSessionId: "new-credential" });
    expect(yield* Fiber.join(replaced.fiber)).toBeUndefined();
    yield* releaseClear;
    yield* releaseReplace;
  }).pipe(Effect.scoped, Effect.provide(McpProviderSessions.layer)),
);
