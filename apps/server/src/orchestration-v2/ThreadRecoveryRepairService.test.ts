import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadRecovery from "./ThreadRecoveryService.ts";
import * as Repair from "./ThreadRecoveryRepairService.ts";

const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const identity = {
  threadId: ThreadId.make("source"),
  runId: RunId.make("run"),
  attemptId: RunAttemptId.make("attempt"),
};
const projectId = ProjectId.make("project");
const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "project-default" };
function harness(
  options: {
    defaultModel?: ModelSelection | null;
    recoveryStatus?: "failed" | "recovering";
    linkFails?: boolean;
    persistLaunch?: boolean;
    emptyRepairShell?: boolean;
    staleAtLaunch?: boolean;
  } = {},
) {
  let source: OrchestrationV2ThreadShell = {
    id: identity.threadId,
    projectId,
    title: "Original work",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "source-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "work",
    worktreePath: "/workspace/work",
    activeProviderThreadId: null,
    lineage: { rootThreadId: identity.threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: identity.runId,
    activeRunId: identity.runId,
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    recovery: {
      runId: identity.runId,
      attemptId: identity.attemptId,
      status: options.recoveryStatus ?? "failed",
      detail: "Final state could not be recorded",
      updatedAt: now,
    },
  };
  const inputs: ThreadLaunch.ThreadLaunchInput[] = [];
  let acceptedRepair: OrchestrationV2ThreadShell | null = null;
  const layer = Repair.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === source.id ? source : acceptedRepair?.id === id ? acceptedRepair : null,
            ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Project",
                workspaceRoot: "/workspace",
                defaultModelSelection:
                  options.defaultModel === undefined ? selection : options.defaultModel,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
                deletedAt: null,
              }),
            ),
        }),
        ServerSettings.layerTest({ defaultRuntimeMode: "approval-required" }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            inputs.push(input);
            if (options.persistLaunch)
              acceptedRepair = {
                ...source,
                id: input.threadId!,
                latestRunId: options.emptyRepairShell ? null : RunId.make("repair-run"),
                activeRunId: null,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                title: input.title,
              };
            return Effect.succeed({
              threadId: input.threadId!,
              resumed: false,
              projection: {
                thread: { ...source, lastVisitedAt: source.lastVisitedAt ?? null },
                runs: [],
                attempts: [],
                nodes: [],
                subagents: [],
                providerSessions: [],
                providerThreads: [],
                providerTurns: [],
                runtimeRequests: [],
                messages: [],
                plans: [],
                turnItems: [],
                checkpointScopes: [],
                checkpoints: [],
                contextHandoffs: [],
                contextTransfers: [],
                visibleTurnItems: [],
                updatedAt: now,
              },
            });
          },
        }),
        Layer.mock(ThreadRecovery.ThreadRecoveryService)({
          assertRepairable: () =>
            options.staleAtLaunch
              ? Effect.fail(
                  new ThreadRecovery.ThreadRecoveryError({
                    threadId: identity.threadId,
                    cause: "new run started",
                  }),
                )
              : Effect.void,
          recordRepairThread: (input) =>
            options.linkFails
              ? Effect.fail(
                  new ThreadRecovery.ThreadRecoveryError({
                    threadId: input.threadId,
                    cause: "write failed",
                  }),
                )
              : Effect.sync(() => {
                  source = {
                    ...source,
                    recovery: { ...source.recovery!, repairThreadId: input.repairThreadId },
                  };
                }),
        }),
      ),
    ),
  );
  return { layer, inputs };
}

describe("ThreadRecoveryRepairService", () => {
  it.effect("retries an empty repair shell whose initial message was not accepted", () => {
    const h = harness({ linkFails: true, persistLaunch: true, emptyRepairShell: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.inputs, 2);
      assert.strictEqual(h.inputs[0]!.commandId, h.inputs[1]!.commandId);
      assert.deepStrictEqual(h.inputs[0]!.modelSelection, h.inputs[1]!.modelSelection);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not relaunch an accepted repair when recording the link failed", () => {
    const h = harness({ linkFails: true, persistLaunch: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.inputs, 1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("does not launch when a newer run superseded the incident", () => {
    const h = harness({ staleAtLaunch: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.inputs, 0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("coalesces concurrent repair clicks", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      const results = yield* Effect.all([service.launch(identity), service.launch(identity)], {
        concurrency: 2,
      });
      assert.deepStrictEqual(results[0], results[1]);
      assert.lengthOf(h.inputs, 1);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "uses project defaults, preserves source workspace, and reuses the linked repair thread",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const service = yield* Repair.ThreadRecoveryRepairService;
        const first = yield* service.launch(identity);
        assert.deepStrictEqual(yield* service.launch(identity), first);
        assert.lengthOf(h.inputs, 1);
        const launch = h.inputs[0]!;
        assert.deepStrictEqual(launch.modelSelection, selection);
        assert.strictEqual(launch.runtimeMode, "approval-required");
        assert.deepStrictEqual(launch.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: "/workspace/work",
          branch: "work",
        });
        assert.strictEqual(launch.createdBy, "user");
        assert.isUndefined(launch.creatorThreadId);
        assert.include(launch.initialMessage!.text, "Do not directly mutate the live database");
        assert.include(launch.initialMessage!.text, "Target attempt: attempt");
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("retries the identical launch when linking its result failed", () => {
    const h = harness({ linkFails: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.inputs, 2);
      assert.strictEqual(h.inputs[0]!.threadId, h.inputs[1]!.threadId);
      assert.strictEqual(h.inputs[0]!.commandId, h.inputs[1]!.commandId);
      assert.strictEqual(
        h.inputs[0]!.initialMessage!.messageId,
        h.inputs[1]!.initialMessage!.messageId,
      );
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([{ defaultModel: null }, { recoveryStatus: "recovering" as const }])(
    "does not launch when %j",
    (options) => {
      const h = harness(options);
      return Effect.gen(function* () {
        const service = yield* Repair.ThreadRecoveryRepairService;
        yield* service.launch(identity).pipe(Effect.flip);
        assert.lengthOf(h.inputs, 0);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("rejects a different attempt", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service
        .launch({ ...identity, attemptId: RunAttemptId.make("old-attempt") })
        .pipe(Effect.flip);
      assert.lengthOf(h.inputs, 0);
    }).pipe(Effect.provide(h.layer));
  });
});
