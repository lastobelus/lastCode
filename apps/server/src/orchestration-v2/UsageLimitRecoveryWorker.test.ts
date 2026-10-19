import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  RunId,
  ThreadId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeSweep } from "./UsageLimitRecoveryWorker.ts";

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
      });
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (previous) => [...previous, command]);
            if (yield* Ref.get(closed)) {
              return yield* new OrchestratorDispatchError({
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
      });
      const sweep = yield* makeSweep.pipe(
        Effect.provide(Layer.mergeAll(projections, threads, settings)),
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
    }),
);
