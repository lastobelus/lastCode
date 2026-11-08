import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { McpProviderSessions, layer } from "./McpProviderSessions.ts";

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
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
