import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  RunId,
  ThreadId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "keeps a usage-limit recovery pending during drain and retries its original identity",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const runId = RunId.make("limit:failed-run");
      const resetAt = DateTime.formatIso(DateTime.subtract(now, { seconds: 1 }));
      const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
        id: ThreadId.make("limit:thread"),
        status: "failed",
        lastErrorClass: "usage_limit",
        latestRunId: runId,
        usageLimitResetAt: resetAt,
        archivedAt: null,
        settledOverride: null,
        pendingRuntimeRequest: null,
        latestRunCompletedAt: DateTime.subtract(now, { seconds: 2 }),
        updatedAt: now,
        snoozedUntil: null,
        limitRecovery: { runId, resetAt, autoResume: true, snooze: false },
      };
      const pending = yield* Ref.make(true);
      const closed = yield* Ref.make(true);
      const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getLimitRecoveryCandidates: () =>
          Ref.get(pending).pipe(Effect.map((value) => (value ? [candidate] : []))),
        getLimitRecoveryWakeAt: () => Effect.succeed(null),
      });
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (previous) => [...previous, command]);
            if (yield* Ref.get(closed)) {
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: new UpdateDrainAdmissionError({
                  reason: "update_draining",
                  requestId: UpdateDrainRequestId.make("limit:drain"),
                  targetVersion: UpdateDrainTargetVersion.make("example-version"),
                  message: "Update pending.",
                }),
              });
            }
            yield* Ref.set(pending, false);
            return {} as never;
          }),
      });
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, autoResumeLimitedThreads: true }),
        streamChanges: Stream.never,
      });
      const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(
        Effect.provide(
          Layer.mergeAll(
            projections,
            threads,
            settings,
            Layer.mock(Orchestrator.OrchestratorV2)({
              autoArmLimitRecovery: () => Effect.die("This recovery is already armed."),
              streamDomainEvents: Stream.never,
            }),
          ),
        ),
      );
      yield* sweep();
      yield* sweep();
      assert.isTrue(yield* Ref.get(pending));
      yield* Ref.set(closed, false);
      yield* sweep();
      yield* sweep();
      assert.isFalse(yield* Ref.get(pending));
      const commands = yield* Ref.get(dispatched);
      assert.equal(commands.length, 3);
      assert.equal(commands[0]?.type, "message.dispatch");
      assert.deepStrictEqual(commands[0], commands[1]);
      assert.deepStrictEqual(commands[0], commands[2]);
    }).pipe(Effect.scoped),
);
