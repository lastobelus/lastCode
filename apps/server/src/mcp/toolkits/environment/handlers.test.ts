import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentPauseError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as EnvironmentPause from "../../../environment/EnvironmentPause.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const callerScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:example",
  thread: {
    threadId,
    providerSessionId: "provider:example",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const pauseStatus: EnvironmentPauseStatus = {
  session: {
    id: "pause-example",
    createdAt: "2026-01-01T00:00:00.000Z",
    phase: "pausing",
    targets: [],
  },
  activeThreadCount: 1,
  blockers: [{ type: "thread-turn", threadId, turnId: null, status: "running" }],
  quiet: false,
  observation: "known",
};
const writeTools = [
  "t3_environment_pause_start",
  "t3_environment_pause_retry",
  "t3_environment_pause_resume",
] as const;
type PauseTool = (typeof writeTools)[number] | "t3_environment_pause_status";

const pauseHarness = (scope = callerScope, initialCaller = liveThreadShell(threadId)) =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const caller = yield* Ref.make(initialCaller);
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const failure = yield* Ref.make<EnvironmentPauseError | null>(null);
    const descriptorGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
    const descriptorEntered = yield* Deferred.make<void>();
    const operation = (name: string) =>
      Ref.update(calls, (previous) => [...previous, name]).pipe(
        Effect.andThen(Ref.get(failure)),
        Effect.flatMap((error) =>
          error === null ? Effect.succeed(pauseStatus) : Effect.fail(error),
        ),
      );
    const dependencies = Layer.mergeAll(
      Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, executor),
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Ref.get(caller),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.gen(function* () {
          const gate = yield* Ref.get(descriptorGate);
          if (gate !== null) {
            yield* Deferred.succeed(descriptorEntered, undefined);
            yield* Deferred.await(gate);
          }
          return {
            environmentId,
            label: "Test environment",
            platform: { os: "linux" as const, arch: "x64" as const },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false, environmentPause: true },
          };
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
      Layer.succeed(
        EnvironmentPause.EnvironmentPause,
        EnvironmentPause.EnvironmentPause.of({
          status: operation("status"),
          // Model dispatch to the caller itself, which needs this same thread lock.
          start: executor.withLock(threadId, operation("start")),
          retry: executor.withLock(threadId, operation("retry")),
          resume: executor.withLock(threadId, operation("resume")),
        }),
      ),
    );
    const invoke = (name: PauseTool) =>
      Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const results = yield* toolkit.handle(name, {}).pipe(Stream.unwrap, Stream.runCollect);
        return results.at(-1)?.result;
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    return { invoke, caller, calls, failure, descriptorGate, descriptorEntered };
  });

it.effect("reads pause status with a read-only environment client", () =>
  Effect.gen(function* () {
    const h = yield* pauseHarness({
      ...callerScope,
      thread: undefined,
      client: { sessionId: "client-example", label: "Read-only client", access: "read-only" },
    });
    expect(yield* h.invoke("t3_environment_pause_status")).toEqual(pauseStatus);
    expect(yield* Ref.get(h.calls)).toEqual(["status"]);
  }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect.each(["t3_environment_pause_status", ...writeTools] as const)(
  "%s refuses a credential belonging to another environment",
  (tool) =>
    Effect.gen(function* () {
      const h = yield* pauseHarness({
        ...callerScope,
        environmentId: EnvironmentId.make("other-environment"),
      });
      expect(yield* h.invoke(tool)).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(h.calls)).toEqual([]);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect.each(writeTools)(
  "%s rejects limited or inactive callers without changing pause state",
  (tool) =>
    Effect.gen(function* () {
      for (const access of ["read-only", "approval-required"] as const) {
        const h = yield* pauseHarness({
          ...callerScope,
          thread: undefined,
          client: { sessionId: "client-example", label: "Limited client", access },
        });
        expect(yield* h.invoke(tool)).toMatchObject({ code: "capability_denied" });
        expect(yield* Ref.get(h.calls)).toEqual([]);
      }
      for (const [caller, code] of [
        [liveThreadShell(threadId, { runtimeMode: "approval-required" }), "capability_denied"],
        [liveThreadShell(threadId, { interactionMode: "plan" }), "capability_denied"],
        [liveThreadShell(threadId, { activeRunId: null }), "parent_not_active"],
        [
          {
            ...liveThreadShell(threadId),
            providerInstanceId: ProviderInstanceId.make("other-provider"),
          },
          "parent_not_active",
        ],
      ] as const) {
        const h = yield* pauseHarness(callerScope, caller);
        expect(yield* h.invoke(tool)).toMatchObject({ code });
        expect(yield* Ref.get(h.calls)).toEqual([]);
      }
    }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect.each(writeTools)(
  "%s permits full-access callers and dispatch to the caller's own thread",
  (tool) =>
    Effect.gen(function* () {
      for (const scope of [
        callerScope,
        {
          ...callerScope,
          thread: undefined,
          client: {
            sessionId: "client-example",
            label: "Full-access client",
            access: "full-access" as const,
          },
        },
      ]) {
        const h = yield* pauseHarness(scope);
        expect(yield* h.invoke(tool)).toEqual(pauseStatus);
        expect(yield* Ref.get(h.calls)).toEqual([tool.replace("t3_environment_pause_", "")]);
      }
    }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect(
  "rechecks the caller after environment identity lookup before writing the pause gate",
  () =>
    Effect.gen(function* () {
      const h = yield* pauseHarness();
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(h.descriptorGate, gate);
      const starting = yield* h.invoke("t3_environment_pause_start").pipe(Effect.forkChild);
      yield* Deferred.await(h.descriptorEntered);
      yield* Ref.update(h.caller, (caller) => ({ ...caller, activeRunId: null }));
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(starting)).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(h.calls)).toEqual([]);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect("returns the public service failure without exposing its internal cause", () =>
  Effect.gen(function* () {
    const h = yield* pauseHarness();
    yield* Ref.set(
      h.failure,
      new EnvironmentPauseError({
        operation: "start",
        reason: "disabled",
        cause: "internal-example-detail",
      }),
    );
    const result = yield* h.invoke("t3_environment_pause_start");
    expect(result).toMatchObject({
      code: "orchestration_error",
      message: "Enable environment pause in Settings before starting a pause.",
    });
    expect(result).not.toHaveProperty("cause");
    expect(yield* Ref.get(h.calls)).toEqual(["start"]);
  }).pipe(Effect.provide(ThreadCommandExecutor.layer)),
);

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    // Completes once the declaration's own check has read the caller.
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A turn-completion command holds the thread's lock.
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      // The update passed its first check and waits for the lock; the turn then ends.
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
