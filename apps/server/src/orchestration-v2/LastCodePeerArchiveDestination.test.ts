import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  type PeerArchiveApplyInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeLastCodeArchiveJournal } from "./LastCodeArchiveJournal.ts";
import { makeLastCodePeerArchiveDestination } from "./LastCodePeerArchiveDestination.ts";
import { PeerArchiveDispatch } from "./LastCodePeerArchiveDispatch.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const db = Sqlite.layerMemory;
const destination = EnvironmentId.make("destination");
const testLayer = Layer.merge(
  db,
  ProviderReplayHarness.layerWithRegistry(
    { name: "peer-archive-destination" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: db, runEffectWorker: false },
  ).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(destination) }),
    ),
  ),
);

const anchor = ThreadId.make("a-anchor");
const child = ThreadId.make("b-child");
const other = ThreadId.make("c-other");
const generation = {
  ownerEnvironmentId: EnvironmentId.make("source"),
  ownerThreadId: ThreadId.make("source-root"),
  sourceArchiveCommandId: CommandId.make("source-archive"),
};
const generationKey = { ...generation, role: "destination" } as const;
const selection = {
  anchorThreadId: anchor,
  selectedThreadIds: [anchor, child],
  typedIn: [],
  childDisposition: "stop_and_archive",
} as const;
const input = {
  ...generation,
  ownerThreadIds: [generation.ownerThreadId],
  cohorts: [selection],
} satisfies PeerArchiveApplyInput;
const client = { sessionId: "link-1", label: "Peer", access: "full-access", linked: true } as const;
const secondClient = { ...client, sessionId: "link-2" };
const pending = { status: "pending", reason: "offline" } as const;
const changed = { status: "blocked", reason: "selection_changed" } as const;
const denied = { status: "blocked", reason: "denied" } as const;
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex");

const thread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  title: id,
  projectId: ProjectId.make("project"),
  createdBy: "agent",
  creationSource: "mcp",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "fixture" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  linkOrigin: client,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  creatorOrigin: {
    kind: "thread_launch",
    environmentId: id === child ? destination : generation.ownerEnvironmentId,
    threadId: id === child ? anchor : generation.ownerThreadId,
    owned: true,
  },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const harness = Effect.gen(function* () {
  const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
  const orchestrator = yield* OrchestratorV2;
  const eventSink = yield* EventSinkV2;
  const receipts = yield* CommandReceiptStoreV2;
  const store = yield* ProjectionStoreV2;
  const ports = { journal, orchestrator, eventSink, receipts };
  const service = yield* makeLastCodePeerArchiveDestination(ports);
  const seed = (ids: readonly ThreadId[]) =>
    Effect.forEach(
      ids,
      (id) =>
        eventSink.write({
          events: [
            {
              id: EventId.make(`created:${id}`),
              type: "thread.created",
              threadId: id,
              occurredAt: now,
              payload: thread(id),
            },
          ],
        }),
      { discard: true },
    );
  const archiveId = (id: ThreadId = anchor) =>
    store.getThread(id).pipe(
      Effect.map((row) => {
        assert.isDefined(row.archivePending);
        return row.archivePending!.commandId;
      }),
    );
  const complete = (attempt: CommandId, threadId: ThreadId = anchor) =>
    orchestrator.dispatch({
      type: "thread.archive.complete",
      commandId: CommandId.make(`${attempt}:complete`),
      threadId,
      requestId: attempt,
    });
  return { service, ports, store, seed, archiveId, complete };
});

it.effect(
  "returns pending acceptance and replays only the generation's committed transitions",
  () =>
    Effect.gen(function* () {
      const { service, ports, store, seed, archiveId, complete } = yield* harness;
      yield* seed([anchor, child]);
      assert.deepStrictEqual(yield* service.apply(client, input), {
        receipts: [],
        remaining: pending,
      });
      const attempt = yield* archiveId();

      const reopened = yield* makeLastCodePeerArchiveDestination(ports);
      const reordered = {
        ...input,
        cohorts: [{ ...selection, selectedThreadIds: [child, anchor] }],
      };
      assert.deepStrictEqual(yield* reopened.apply(client, reordered), {
        receipts: [],
        remaining: pending,
      });
      assert.strictEqual(yield* archiveId(), attempt);
      assert.deepStrictEqual(yield* reopened.apply(secondClient, input).pipe(Effect.flip), denied);
      assert.deepStrictEqual(
        yield* reopened.restore(secondClient, generation).pipe(Effect.flip),
        denied,
      );
      assert.deepStrictEqual(
        yield* reopened
          .apply(client, {
            ...input,
            cohorts: [{ ...selection, selectedThreadIds: [anchor] }],
          })
          .pipe(Effect.flip),
        changed,
      );

      yield* complete(attempt);
      const applied = yield* reopened.apply(client, input);
      assert.isUndefined(applied.remaining);
      assert.deepStrictEqual(applied.receipts[0]?.threads.map((entry) => entry.threadId).sort(), [
        anchor,
        child,
      ]);
      for (const entry of applied.receipts[0]?.threads ?? []) {
        assert.deepStrictEqual(entry.archivedWith, { threadId: anchor, commandId: attempt });
        assert.strictEqual(
          entry.archivedAt,
          DateTime.formatIso((yield* store.getThread(entry.threadId)).archivedAt!),
        );
      }
      const nextGeneration = {
        ...generation,
        sourceArchiveCommandId: CommandId.make("new-source-command"),
      };
      assert.deepStrictEqual(yield* reopened.restore(client, nextGeneration), {
        restoredThreadIds: [],
      });
      assert.isNotNull((yield* store.getThread(anchor)).archivedAt);
      const restored = yield* reopened.restore(client, generation);
      assert.isUndefined(restored.remaining);
      assert.deepStrictEqual([...restored.restoredThreadIds].sort(), [anchor, child]);
      assert.deepStrictEqual(yield* service.restore(client, generation), restored);
      assert.deepStrictEqual(yield* service.apply(client, input).pipe(Effect.flip), changed);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("persists a session-bound restore fence before the first apply", () =>
  Effect.gen(function* () {
    const { service, ports, seed, store } = yield* harness;
    yield* seed([anchor, child]);
    assert.deepStrictEqual(yield* service.restore(client, generation), { restoredThreadIds: [] });
    assert.isNotNull(yield* ports.journal.read(generationKey));
    const reopened = yield* makeLastCodePeerArchiveDestination(ports);
    assert.deepStrictEqual(yield* reopened.apply(secondClient, input).pipe(Effect.flip), denied);
    assert.deepStrictEqual(yield* reopened.apply(client, input).pipe(Effect.flip), changed);
    assert.isTrue((yield* store.getThread(anchor)).archivePending == null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("restores a committed cohort while waiting for another admitted cohort", () =>
  Effect.gen(function* () {
    const { service, seed, store, archiveId, complete } = yield* harness;
    yield* seed([anchor, child, other]);
    const reviewed = {
      ...input,
      cohorts: [selection, { ...selection, anchorThreadId: other, selectedThreadIds: [other] }],
    };
    assert.deepStrictEqual(yield* service.apply(client, reviewed), {
      receipts: [],
      remaining: pending,
    });
    const first = yield* archiveId();
    const second = yield* archiveId(other);
    assert.notStrictEqual(first, second);
    yield* complete(first);
    const partial = yield* service.apply(client, reviewed);
    assert.deepStrictEqual(
      partial.receipts.map((entry) => entry.anchorThreadId),
      [anchor],
    );
    assert.deepStrictEqual(partial.remaining, pending);

    const restored = yield* service.restore(client, generation);
    assert.deepStrictEqual([...restored.restoredThreadIds].sort(), [anchor, child]);
    assert.deepStrictEqual(restored.remaining, pending);
    assert.strictEqual((yield* store.getThread(other)).archivePending?.commandId, second);
    assert.deepStrictEqual(yield* service.apply(client, reviewed).pipe(Effect.flip), changed);

    yield* complete(second, other);
    const done = yield* service.restore(client, generation);
    assert.deepStrictEqual([...done.restoredThreadIds].sort(), [anchor, child, other]);
    assert.isUndefined(done.remaining);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retries a rejected dispatch and a failed shutdown with separate exact attempts", () =>
  Effect.gen(function* () {
    const { ports, store, seed, archiveId, complete } = yield* harness;
    const dispatched: CommandId[] = [];
    const service = yield* makeLastCodePeerArchiveDestination({
      ...ports,
      orchestrator: {
        dispatch: (command) =>
          Effect.sync(() => dispatched.push(command.commandId)).pipe(
            Effect.andThen(ports.orchestrator.dispatch(command)),
          ),
      },
    });
    yield* seed([anchor, child]);
    const setProtection = (persistent: boolean) =>
      store.apply({
        id: EventId.make(`fixture:protected:${persistent}`),
        type: "thread.metadata-updated",
        threadId: child,
        occurredAt: now,
        payload: { ...thread(child), persistent },
      });
    yield* setProtection(true);
    assert.deepStrictEqual(yield* service.apply(client, input), {
      receipts: [],
      remaining: changed,
    });
    yield* setProtection(false);
    assert.deepStrictEqual(yield* service.apply(client, input), {
      receipts: [],
      remaining: pending,
    });
    const first = yield* archiveId();
    assert.notStrictEqual(first, dispatched[0]);
    yield* ports.orchestrator.dispatch({
      type: "thread.archive.fail",
      commandId: CommandId.make(`${first}:failed`),
      threadId: anchor,
      requestId: first,
      error: "Provider shutdown failed.",
    });
    assert.deepStrictEqual(yield* service.apply(client, input), {
      receipts: [],
      remaining: pending,
    });
    const retry = yield* archiveId();
    assert.notStrictEqual(retry, first);
    yield* complete(retry);
    const result = yield* service.apply(client, input);
    assert.deepStrictEqual(
      result.receipts[0]?.threads.map((row) => row.archivedWith.commandId),
      [retry, retry],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "resumes the same admitted command after interruption without widening its mode ceiling",
  () =>
    Effect.gen(function* () {
      const { ports, seed, archiveId, complete } = yield* harness;
      yield* seed([anchor, child]);
      const entered = yield* Deferred.make<CommandId>();
      const interruptedService = yield* makeLastCodePeerArchiveDestination({
        ...ports,
        orchestrator: {
          dispatch: (command) =>
            Deferred.succeed(entered, command.commandId).pipe(Effect.andThen(Effect.never)),
        },
      });
      const restricted = {
        ...client,
        narrowedTo: { runtimeMode: "auto", interactionMode: "default" },
      } as const;
      const fiber = yield* Effect.forkScoped(interruptedService.apply(restricted, input));
      const admitted = yield* Deferred.await(entered);
      assert.isNotNull(yield* ports.journal.read(generationKey));
      yield* Fiber.interrupt(fiber);

      const resumed = yield* makeLastCodePeerArchiveDestination({
        ...ports,
        orchestrator: {
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.archive") {
                assert.strictEqual(command.commandId, admitted);
                assert.deepStrictEqual(
                  (yield* PeerArchiveDispatch)?.client.narrowedTo,
                  restricted.narrowedTo,
                );
                assert.deepStrictEqual(yield* DispatchModeLimit, restricted.narrowedTo);
              }
              return yield* ports.orchestrator.dispatch(command);
            }),
        },
      });
      assert.deepStrictEqual(yield* resumed.apply(client, input), {
        receipts: [],
        remaining: pending,
      });
      assert.strictEqual(yield* archiveId(), admitted);
      yield* complete(admitted);
      assert.deepStrictEqual(
        [...(yield* resumed.restore(client, generation)).restoredThreadIds].sort(),
        [anchor, child],
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("restore fences a reserved attempt that never reached archive admission", () =>
  Effect.gen(function* () {
    const { ports, seed, store } = yield* harness;
    yield* seed([anchor, child]);
    const entered = yield* Deferred.make<void>();
    const service = yield* makeLastCodePeerArchiveDestination({
      ...ports,
      orchestrator: {
        dispatch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      },
    });
    const fiber = yield* Effect.forkScoped(service.apply(client, input));
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const restarted = yield* makeLastCodePeerArchiveDestination(ports);
    assert.deepStrictEqual(yield* restarted.restore(client, generation), { restoredThreadIds: [] });
    assert.isUndefined((yield* store.getThread(anchor)).archivePending);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects malformed selections and filters foreign rows from a partial archive receipt",
  () =>
    Effect.gen(function* () {
      const { ports } = yield* harness;
      let admitted: CommandId | undefined;
      let restored: CommandId | undefined;
      const stored = (
        commandId: CommandId,
        id: ThreadId,
        marker: CommandId,
      ): OrchestrationV2StoredEvent => ({
        sequence: 1,
        commandId,
        event: {
          type: "thread.archived",
          id: EventId.make(`fixture:${id}`),
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread(id),
            archivedAt: now,
            archivedWith: { threadId: anchor, commandId: marker },
          },
        },
      });
      const service = yield* makeLastCodePeerArchiveDestination({
        ...ports,
        orchestrator: {
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.unarchive") {
                const scope = yield* PeerArchiveDispatch;
                assert.strictEqual(scope?.kind, "restore");
                if (scope?.kind !== "restore") return yield* Effect.die("Missing restore scope");
                assert.deepStrictEqual(
                  scope.committed.map((row) => row.threadId),
                  [anchor],
                );
                restored = command.commandId;
                yield* ports.receipts
                  .insertIfAbsent({
                    commandId: restored,
                    threadId: anchor,
                    commandType: "thread.unarchive",
                    acceptedAt: now,
                    resultSequence: 2,
                    status: "accepted",
                    error: null,
                  })
                  .pipe(Effect.orDie);
              } else admitted = command.commandId;
              return { sequence: 1, storedEvents: [] };
            }),
        },
        eventSink: {
          readByCommandId: ({ commandId }) => {
            if (restored === commandId) {
              return Stream.make({
                sequence: 2,
                commandId,
                event: {
                  type: "thread.unarchived",
                  id: EventId.make("fixture:restored"),
                  threadId: anchor,
                  occurredAt: now,
                  payload: { ...thread(anchor), archivedWith: null },
                },
              });
            }
            if (admitted === undefined || commandId !== `${admitted}:complete`) return Stream.empty;
            return Stream.fromIterable([
              stored(commandId, anchor, admitted),
              stored(commandId, child, CommandId.make("different-attempt")),
              stored(commandId, other, admitted),
              stored(CommandId.make("different-event-command"), child, admitted),
            ]);
          },
        },
      });
      for (const malformed of [
        { ...input, ownerThreadIds: [other] },
        { ...input, cohorts: [selection, selection] },
        { ...input, cohorts: [{ ...selection, selectedThreadIds: [anchor, anchor] }] },
        { ...input, cohorts: [{ ...selection, selectedThreadIds: [child] }] },
        {
          ...input,
          cohorts: [
            selection,
            { ...selection, anchorThreadId: other, selectedThreadIds: [other, child] },
          ],
        },
      ]) {
        assert.deepStrictEqual(yield* service.apply(client, malformed).pipe(Effect.flip), changed);
      }
      assert.isUndefined(admitted);
      assert.isNull(yield* ports.journal.read(generationKey));

      const partial = yield* service.apply(client, input);
      assert.deepStrictEqual(partial, {
        receipts: [
          {
            anchorThreadId: anchor,
            threads: [
              {
                threadId: anchor,
                archivedAt: DateTime.formatIso(now),
                archivedWith: { threadId: anchor, commandId: admitted! },
              },
            ],
          },
        ],
        remaining: changed,
      });
      assert.deepStrictEqual(yield* service.restore(client, generation), {
        restoredThreadIds: [anchor],
        remaining: changed,
      });
    }).pipe(Effect.provide(testLayer)),
);
