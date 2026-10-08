import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadRecovery from "./ThreadRecoveryService.ts";
import * as Repair from "./ThreadRecoveryRepairService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";

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
    launchFails?: boolean;
    supersedeAtShell?: boolean;
    supersedeAtLaunch?: boolean;
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
  const deletedRepairs = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const reopened: ThreadId[] = [];
  const created: ThreadId[] = [];
  const accepted = new Map<string, CommandReceiptStore.CommandReceiptV2>();
  let launchFails = options.launchFails ?? false;
  const supersede = () => {
    source = { ...source, recovery: undefined };
  };
  const layer = Repair.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === source.id ? source : acceptedRepair?.id === id ? acceptedRepair : null,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create") {
                created.push(command.threadId);
                acceptedRepair = {
                  ...source,
                  id: command.threadId,
                  latestRunId: null,
                  activeRunId: null,
                  recovery: undefined,
                  status: "idle",
                  modelSelection: command.modelSelection,
                  runtimeMode: command.runtimeMode,
                  title: command.title,
                  branch: command.branch,
                  worktreePath: command.worktreePath,
                };
                if (options.supersedeAtShell) supersede();
              }
              if (command.type === "thread.unarchive") {
                reopened.push(command.threadId);
                if (acceptedRepair?.id === command.threadId)
                  acceptedRepair = { ...acceptedRepair, archivedAt: null };
              }
              return { sequence: 0, storedEvents: [] };
            }),
        }),
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: (id) =>
            Effect.sync(() => {
              const receipt = accepted.get(id);
              return receipt === undefined ? Option.none() : Option.some(receipt);
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (id, fields) => {
            const deleted = deletedRepairs.get(id);
            return deleted === undefined
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                )
              : Effect.succeed({
                  thread: deleted as unknown as OrchestrationV2AppThread,
                } as ProjectionStore.ProjectionRecords<(typeof fields)[number]>);
          },
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
          launch: (input) =>
            Effect.gen(function* () {
              inputs.push(input);
              assert.isTrue(
                accepted.has(ThreadRecovery.repairAcceptanceCommandId(input.threadId!)),
              );
              if (options.supersedeAtLaunch) supersede();
              if (launchFails)
                return yield* new ThreadLaunch.ThreadLaunchError({
                  commandId: input.commandId,
                  threadId: input.threadId,
                  operation: "dispatch-message",
                  projectId,
                  cause: "message not accepted",
                });
              acceptedRepair = {
                ...acceptedRepair!,
                latestRunId: RunId.make("repair-run"),
                activeRunId: null,
              };
              return {
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
              };
            }),
        }),
        Layer.mock(ThreadRecovery.ThreadRecoveryService)({
          withRepairableIncident: (_input, effect) =>
            options.staleAtLaunch
              ? Effect.fail(
                  new ThreadRecovery.ThreadRecoveryError({
                    threadId: identity.threadId,
                    cause: "new run started",
                  }),
                )
              : effect((repairThreadId) =>
                  Effect.gen(function* () {
                    if (options.linkFails || source.recovery?.attemptId !== identity.attemptId)
                      return yield* new ThreadRecovery.ThreadRecoveryError({
                        threadId: identity.threadId,
                        cause: "incident changed or write failed",
                      });
                    source = { ...source, recovery: { ...source.recovery, repairThreadId } };
                    const commandId = ThreadRecovery.repairAcceptanceCommandId(repairThreadId);
                    accepted.set(commandId, {
                      commandId,
                      threadId: repairThreadId,
                      commandType: "thread.recovery-repair.accept",
                      acceptedAt: now,
                      resultSequence: 1,
                      status: "accepted",
                      error: null,
                    });
                  }),
                ),
        }),
      ),
    ),
  );
  return {
    layer,
    inputs,
    reopened,
    created,
    accepted,
    supersede,
    failLaunch(value: boolean) {
      launchFails = value;
    },
    deleteRepair() {
      if (acceptedRepair === null) throw new Error("No repair exists");
      deletedRepairs.set(acceptedRepair.id, { ...acceptedRepair, deletedAt: now });
      acceptedRepair = null;
    },
    archiveRepair() {
      if (acceptedRepair === null) throw new Error("No repair exists");
      acceptedRepair = { ...acceptedRepair, archivedAt: now };
    },
    leaveRepairPreparing() {
      if (acceptedRepair === null) throw new Error("No repair exists");
      acceptedRepair = { ...acceptedRepair, status: "preparing" };
    },
  };
}

describe("ThreadRecoveryRepairService", () => {
  it.effect("replaces deleted linked repair conversations and reuses each replacement", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      const first = yield* service.launch(identity);
      h.deleteRepair();
      const second = yield* service.launch(identity);
      assert.notEqual(second.threadId, first.threadId);
      assert.deepEqual(yield* service.launch(identity), second);
      h.deleteRepair();
      const third = yield* service.launch(identity);
      assert.notEqual(third.threadId, first.threadId);
      assert.notEqual(third.threadId, second.threadId);
      assert.deepEqual(yield* service.launch(identity), third);
      assert.lengthOf(h.inputs, 3);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("never starts a provider when acceptance fails", () => {
    const h = harness({ linkFails: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.inputs, 0);
      assert.lengthOf(h.created, 1);
      assert.equal(h.accepted.size, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "rejects supersession between inert creation and acceptance without starting an agent",
    () => {
      const h = harness({ supersedeAtShell: true });
      return Effect.gen(function* () {
        const service = yield* Repair.ThreadRecoveryRepairService;
        yield* service.launch(identity).pipe(Effect.flip);
        assert.lengthOf(h.inputs, 0);
        assert.equal(h.accepted.size, 0);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("returns an accepted repair even when the source advances during launch", () => {
    const h = harness({ supersedeAtLaunch: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      const first = yield* service.launch(identity);
      assert.deepEqual(yield* service.launch(identity), first);
      assert.lengthOf(h.inputs, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("resumes the accepted identity after launch failure and source supersession", () => {
    const h = harness({ launchFails: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      h.supersede();
      h.failLaunch(false);
      const result = yield* service.launch(identity);
      assert.deepEqual(yield* service.launch(identity), result);
      assert.lengthOf(h.inputs, 2);
      assert.equal(h.inputs[0]!.threadId, result.threadId);
      assert.equal(h.inputs[0]!.commandId, h.inputs[1]!.commandId);
      assert.deepEqual(h.inputs[0]!.modelSelection, h.inputs[1]!.modelSelection);
      assert.equal(h.inputs[0]!.initialMessage!.messageId, h.inputs[1]!.initialMessage!.messageId);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("skips a deleted inert repair whose acceptance was not recorded", () => {
    const h = harness({ linkFails: true });
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      yield* service.launch(identity).pipe(Effect.flip);
      h.deleteRepair();
      yield* service.launch(identity).pipe(Effect.flip);
      yield* service.launch(identity).pipe(Effect.flip);
      assert.lengthOf(h.created, 2);
      assert.notEqual(h.created[0], h.created[1]);
      assert.lengthOf(h.inputs, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("resumes accepted preparation after the source incident advances", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      const first = yield* service.launch(identity);
      h.leaveRepairPreparing();
      h.supersede();
      assert.deepEqual(yield* service.launch(identity), first);
      assert.lengthOf(h.inputs, 2);
      assert.equal(h.inputs[0]!.commandId, h.inputs[1]!.commandId);
      assert.equal(h.inputs[0]!.initialMessage!.messageId, h.inputs[1]!.initialMessage!.messageId);
      assert.equal(h.accepted.size, 1);
      assert.lengthOf(h.created, 1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reopens an archived repair without launching its agent again", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Repair.ThreadRecoveryRepairService;
      const first = yield* service.launch(identity);
      h.archiveRepair();
      assert.deepEqual(yield* service.launch(identity), first);
      assert.deepEqual(h.reopened, [first.threadId]);
      assert.deepEqual(yield* service.launch(identity), first);
      assert.lengthOf(h.reopened, 1);
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
