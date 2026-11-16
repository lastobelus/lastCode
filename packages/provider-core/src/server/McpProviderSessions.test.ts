import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { hasNativeMcpMetadata, McpProviderSessions, layer } from "./McpProviderSessions.ts";

it.effect(
  "freezes native origins across reused turns and rejects foreign, missing and ended origins",
  () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions;
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
      expect(hasNativeMcpMetadata({})).toBe(false);
      expect(hasNativeMcpMetadata({ unrelated: true })).toBe(false);
      for (const malformed of [
        { "x-codex-turn-metadata": null },
        { "x-codex-turn-metadata": { thread_id: "native", turn_id: "" } },
        { "claudecode/toolUseId": null },
        { "claudecode/toolUseId": " " },
        { ...meta("a"), "claudecode/toolUseId": null },
      ]) {
        expect(hasNativeMcpMetadata(malformed)).toBe(true);
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
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("retains more than 4096 live tool origins and ends native children independently", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions;
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
    expect(childA).toEqual({ ...a, isLiveBackground: expect.any(Function) });
    expect(childB).toEqual({ ...a, isLiveBackground: expect.any(Function) });
    expect(childA.isLiveBackground?.()).toBe(true);
    expect(childB.isLiveBackground?.()).toBe(true);
    yield* sessions.endExecution(threadId, a, "native-child-a");
    expect(yield* lookup("child-a")).toBeUndefined();
    expect((yield* lookup("child-b"))?.isLiveBackground?.()).toBe(true);
    expect(childA.isLiveBackground?.()).toBe(false);
    yield* sessions.registerExecution(threadId, origin("child-a"), a, "native-child-b");
    expect(yield* lookup("child-a")).toBeUndefined();
    yield* sessions.endExecution(threadId, a, "native-child-b");
    expect(yield* lookup("child-b")).toBeUndefined();
    expect(childB.isLiveBackground?.()).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("isolates known pending Codex children and releases cancelled credential waits", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions;
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
    expect(resolved?.isLiveBackground?.()).toBe(true);
    yield* releaseA;
    yield* releaseA;
    expect(yield* Deferred.isDone(b.done)).toBe(false);
    yield* releaseB;
    expect(yield* Fiber.join(b.fiber)).toBeUndefined();
    const releaseClear = yield* sessions.beginCodexTurn(threadId, "clear");
    const cleared = yield* pending("clear");
    yield* sessions.clear(threadId);
    expect(yield* Fiber.join(cleared.fiber)).toBeUndefined();
    expect(resolved?.isLiveBackground?.()).toBe(false);
    yield* sessions.set(config);
    const releaseReplace = yield* sessions.beginCodexTurn(threadId, "replace");
    const replaced = yield* pending("replace");
    yield* sessions.set({ ...config, providerSessionId: "new-credential" });
    expect(yield* Fiber.join(replaced.fiber)).toBeUndefined();
    yield* releaseClear;
    yield* releaseReplace;
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
