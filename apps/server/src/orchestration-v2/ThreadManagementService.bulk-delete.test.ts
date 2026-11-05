import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkspaceLifecycleRunInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspaceLifecycle from "../workspace/WorkspaceLifecycle.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const database = SqlitePersistence.layerMemory;
const layer = Layer.fresh(ThreadManagementService.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      WorkspaceLifecycle.layer,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "bulk-thread-delete" },
        ProviderAdapterRegistry.layerFromAdapters([]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);
const first = ThreadId.make("bulk:first");
const second = ThreadId.make("bulk:second");
const create = Effect.fn("BulkDeletionTest.create")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("bulk:project"),
    title: threadId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example-model" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
const preview = () => Effect.die("Unused preview");

it.effect(
  "binds the full selected owner set to one lifecycle run and existing individual receipts",
  () =>
    Effect.gen(function* () {
      yield* create(first);
      yield* create(second);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const lifecycle = yield* WorkspaceLifecycle.WorkspaceLifecycle;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const calls: WorkspaceLifecycleRunInput[] = [];
      yield* lifecycle.install({
        preview,
        run: (input, commit) =>
          commit.pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                calls.push(input);
                for (const binding of input.deleteReceipts ?? []) {
                  const receipt = yield* receipts.getByCommandId(binding.commandId);
                  assert.isTrue(Option.isSome(receipt));
                  if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
                  assert.isNotNull((yield* projections.getThread(binding.threadId)).deletedAt);
                }
              }).pipe(Effect.orDie),
            ),
          ),
      });
      const result = yield* threads.deleteMany({
        commandId: CommandId.make("bulk:delete"),
        threads: [{ threadId: second }, { threadId: first }, { threadId: first }],
        savedWorkspace: { mode: "discard", previewToken: "complete-selection" },
      });
      assert.deepEqual(result.deletedThreadIds.toSorted(), [first, second]);
      assert.lengthOf(calls, 1);
      assert.deepEqual(calls[0]?.target, { kind: "threads", threadIds: [first, second] });
      assert.deepEqual(calls[0]?.deleteReceipts, [
        { threadId: second, commandId: CommandId.make("bulk:delete:delete:bulk:second") },
        { threadId: first, commandId: CommandId.make("bulk:delete:delete:bulk:first") },
      ]);
      assert.isUndefined(result.failureMessage);
    }).pipe(Effect.provide(layer)),
);

it.effect("a rejected member does not grant the combined disposal callback success", () =>
  Effect.gen(function* () {
    yield* create(first);
    yield* create(second);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.persistence.set",
      threadId: second,
      commandId: CommandId.make("bulk:protect"),
      persistent: true,
    });
    const lifecycle = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    let disposalGranted = false;
    yield* lifecycle.install({
      preview,
      run: (_input, commit) =>
        commit.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              disposalGranted = true;
            }),
          ),
        ),
    });
    const result = yield* threads.deleteMany({
      commandId: CommandId.make("bulk:partial"),
      threads: [{ threadId: first }, { threadId: second }],
      savedWorkspace: { mode: "discard", previewToken: "complete-selection" },
    });
    assert.deepEqual(result.deletedThreadIds, [first]);
    assert.isString(result.failureMessage);
    assert.isFalse(disposalGranted);
    assert.isNotNull((yield* projections.getThread(first)).deletedAt);
    assert.isNull((yield* projections.getThread(second)).deletedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("a selected native child is deleted once by its selected owner", () =>
  Effect.gen(function* () {
    yield* create(first);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = (yield* threads.getThreadRecords(first, [])).thread;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("bulk:create-child"),
      type: "thread.created",
      threadId: second,
      occurredAt: now,
      payload: {
        ...parent,
        id: second,
        title: "Native child",
        lineage: { parentThreadId: first, relationshipToParent: "subagent", rootThreadId: first },
        createdAt: now,
        updatedAt: now,
      },
    });
    const lifecycle = yield* WorkspaceLifecycle.WorkspaceLifecycle;
    const calls: WorkspaceLifecycleRunInput[] = [];
    yield* lifecycle.install({
      preview,
      run: (input, commit) => Effect.sync(() => calls.push(input)).pipe(Effect.andThen(commit)),
    });
    const result = yield* threads.deleteMany({
      commandId: CommandId.make("bulk:family"),
      threads: [{ threadId: first }, { threadId: second }],
      savedWorkspace: { mode: "retain" },
    });
    assert.deepEqual(result.deletedThreadIds.toSorted(), [first, second]);
    assert.deepEqual(calls[0]?.deleteReceipts, [
      { threadId: first, commandId: CommandId.make("bulk:family:delete:bulk:first") },
    ]);
    assert.isNotNull((yield* projections.getThread(second)).deletedAt);
  }).pipe(Effect.provide(layer)),
);
