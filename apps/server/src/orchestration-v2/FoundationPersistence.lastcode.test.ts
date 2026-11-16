import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerApplicationEventsProvided = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(layerDatabase),
);
const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provideMerge(layerApplicationEventsProvided),
);
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEffectOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
  Layer.provide(layerDatabase),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

it.effect.each(
  (["write", "writeIfRunCurrent"] as const).flatMap((caller) =>
    (["cancel transaction", "fail transaction", "cancel publication"] as const).map((scenario) => ({
      caller,
      scenario,
    })),
  ),
)(
  "$caller preserves event consistency and allows later writes after $scenario",
  ({ caller, scenario }) =>
    Effect.gen(function* () {
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = scenario === "cancel publication";
      const notifications: Array<number | undefined> = [];
      const pause = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const layerPausingOutbox = Layer.effect(
        EffectOutbox.EffectOutboxV2,
        Effect.gen(function* () {
          const delegate = yield* EffectOutbox.EffectOutboxV2;
          return EffectOutbox.EffectOutboxV2.of({
            ...delegate,
            enqueue: (effects) =>
              delegate
                .enqueue(effects)
                .pipe(
                  Effect.andThen(!committed && effects.length > 0 ? pause : Effect.void),
                  Effect.andThen(
                    scenario === "fail transaction" && effects.length > 0
                      ? Effect.die("Injected transaction failure")
                      : Effect.void,
                  ),
                ),
            notifyAvailable: (count) =>
              (committed ? pause : Effect.void).pipe(
                Effect.andThen(delegate.notifyAvailable(count)),
                Effect.tap(() => Effect.sync(() => notifications.push(count))),
              ),
          });
        }),
      ).pipe(Layer.provide(layerEffectOutboxProvided));
      const layerEventSink = EventSink.layerFromStores.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerStoresProvided,
            layerPausingOutbox,
            layerCommandReceiptStoreProvided,
            ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
            TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
        const now = yield* DateTime.now;
        const metricsProvider = ProviderInstanceId.make(
          `publication-${caller}-${scenario.replaceAll(" ", "-")}`,
        );
        const runId = RunId.make("run:interrupted-publish");
        const activeAttemptId = RunAttemptId.make("attempt:interrupted-publish");
        const first = makeThread(ThreadId.make("thread:interrupted-publish:first"), now);
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: first.id,
          ordinal: 1,
          providerInstanceId: metricsProvider,
          modelSelection: { instanceId: metricsProvider, model: "gpt-5.4" },
          providerThreadId: null,
          userMessageId: MessageId.make("message:interrupted-publish"),
          rootNodeId: null,
          activeAttemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* eventSink.write({
          events: [
            threadCreatedEvent({ id: "event:interrupted-publish:thread", thread: first, now }),
            {
              id: EventId.make("event:interrupted-publish:run"),
              type: "run.created",
              threadId: first.id,
              runId,
              occurredAt: now,
              payload: run,
            },
          ],
        });
        const marker = makeThread(ThreadId.make("thread:interrupted-publish:marker"), now);
        const afterSequence = yield* applicationEvents.latestApplicationSequence;
        const published = yield* eventSink.stream({ afterSequence }).pipe(
          Stream.takeUntil((stored) => stored.event.threadId === marker.id),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const committedEvents = yield* applicationEvents
          .streamApplicationEvents({ afterSequence })
          .pipe(
            Stream.takeUntil((stored) => "event" in stored && stored.event.threadId === marker.id),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
        const input = {
          threadId: first.id,
          runId,
          activeAttemptId,
          expectedStatus: "running" as const,
          events: [
            {
              id: EventId.make("event:interrupted-publish:first"),
              type: "run.updated" as const,
              threadId: first.id,
              runId,
              occurredAt: now,
              payload: { ...run, status: "completed" as const, completedAt: now },
            },
          ],
          effects: [
            {
              id: "effect:interrupted-publish:first",
              commandId: CommandId.make("command:interrupted-publish:first"),
              threadId: first.id,
              request: { type: "terminal.cleanup" as const },
            },
          ],
        };
        if (caller === "writeIfRunCurrent") {
          const rejected = yield* eventSink.writeIfRunCurrent({
            ...input,
            activeAttemptId: RunAttemptId.make("attempt:stale-publication"),
          });
          assert.isFalse(rejected.committed);
          assert.deepEqual(rejected.storedEvents, []);
          assert.isTrue(Option.isNone(yield* outbox.get("effect:interrupted-publish:first")));
        }
        const writer = yield* (
          caller === "write"
            ? eventSink.writeWithEffects(input)
            : eventSink.writeIfRunCurrent(input)
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        if (scenario !== "fail transaction") writer.interruptUnsafe();
        if (scenario !== "cancel transaction") yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.await(writer))._tag, "Failure");
        assert.equal(
          (yield* projections.getThreadProjection(first.id)).runs[0]?.status,
          committed ? "completed" : "running",
        );
        assert.equal(
          Option.isSome(yield* outbox.get("effect:interrupted-publish:first")),
          committed,
        );
        assert.deepEqual(notifications, committed ? [1] : []);
        if (committed) yield* outbox.awaitAvailable;
        const outcomes = (yield* Metric.snapshot).filter(
          (snapshot) =>
            snapshot.id === "t3_runs_total" && snapshot.attributes?.provider === metricsProvider,
        );
        assert.equal(
          outcomes.reduce(
            (total, snapshot) =>
              total + (snapshot.type === "Counter" ? Number(snapshot.state.count) : 0),
            0,
          ),
          committed ? 1 : 0,
        );
        yield* eventSink.write({
          events: [
            threadCreatedEvent({ id: "event:interrupted-publish:marker", thread: marker, now }),
          ],
        });
        const live = yield* Fiber.join(published);
        const application = yield* Fiber.join(committedEvents);
        assert.deepEqual(
          Array.from(live, (stored) => stored.event.threadId),
          committed ? [first.id, marker.id] : [marker.id],
        );
        assert.deepEqual(
          Array.from(application, (stored) => stored.sequence),
          Array.from(live, (stored) => stored.sequence),
        );
        assert.deepEqual(
          Array.from(application),
          Array.from(
            yield* applicationEvents
              .readApplicationEvents({
                afterSequence,
                throughSequence: yield* applicationEvents.latestApplicationSequence,
              })
              .pipe(Stream.runCollect),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerEventSink, layerStoresProvided, layerEffectOutboxProvided),
        ),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rolls back a writer cancelled while waiting for committed publication", () =>
  Effect.gen(function* () {
    const firstCommitted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondPrepared = yield* Deferred.make<void>();
    const layerPausingOutbox = Layer.effect(
      EffectOutbox.EffectOutboxV2,
      Effect.gen(function* () {
        const delegate = yield* EffectOutbox.EffectOutboxV2;
        return EffectOutbox.EffectOutboxV2.of({
          ...delegate,
          enqueue: (effects) =>
            delegate
              .enqueue(effects)
              .pipe(
                Effect.andThen(
                  effects.some((effect) => effect.id === "effect:cancel-lane:second")
                    ? Deferred.succeed(secondPrepared, undefined).pipe(
                        Effect.forkChild({ startImmediately: false }),
                      )
                    : Effect.void,
                ),
              ),
          notifyAvailable: (count) =>
            Deferred.succeed(firstCommitted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(delegate.notifyAvailable(count)),
            ),
        });
      }),
    ).pipe(Layer.provide(layerEffectOutboxProvided));
    const layerEventSink = EventSink.layerFromStores.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerStoresProvided,
          layerPausingOutbox,
          layerCommandReceiptStoreProvided,
          ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
          TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const first = makeThread(ThreadId.make("thread:cancel-lane:first"), now);
      const second = makeThread(ThreadId.make("thread:cancel-lane:second"), now);
      const marker = makeThread(ThreadId.make("thread:cancel-lane:marker"), now);
      const published = yield* sink.stream({ afterSequence: yield* sink.latestSequence() }).pipe(
        Stream.takeUntil((stored) => stored.event.threadId === marker.id),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const write = (thread: OrchestrationV2AppThread, key: string) =>
        sink.writeWithEffects({
          events: [threadCreatedEvent({ id: `event:cancel-lane:${key}`, thread, now })],
          effects: [
            {
              id: `effect:cancel-lane:${key}`,
              commandId: CommandId.make(`command:cancel-lane:${key}`),
              threadId: thread.id,
              request: { type: "terminal.cleanup" },
            },
          ],
        });
      const firstWriter = yield* write(first, "first").pipe(Effect.forkScoped);
      yield* Deferred.await(firstCommitted);
      const secondWriter = yield* write(second, "second").pipe(
        // Run from the prepared barrier to the lane wait before resuming this fiber.
        Effect.provideService(Scheduler.MaxOpsBeforeYield, Number.POSITIVE_INFINITY),
        Effect.forkScoped,
      );
      yield* Deferred.await(secondPrepared);
      secondWriter.interruptUnsafe();
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(firstWriter);
      assert.equal((yield* Fiber.await(secondWriter))._tag, "Failure");
      assert.isNull(yield* projections.getThreadShell(second.id));
      assert.isTrue(Option.isNone(yield* outbox.get("effect:cancel-lane:second")));
      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:cancel-lane:marker", thread: marker, now })],
      });
      assert.deepEqual(
        Array.from(yield* Fiber.join(published), (stored) => stored.event.threadId),
        [first.id, marker.id],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerEventSink, layerStoresProvided, layerEffectOutboxProvided),
      ),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["before commit", "after commit"] as const)(
  "preserves project command consistency when cancelled %s",
  (phase) =>
    Effect.gen(function* () {
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = phase === "after commit";
      const firstId = ProjectId.make("project:cancel-publication:first");
      const markerId = ProjectId.make("project:cancel-publication:marker");
      const pause = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const layerPausedProjects = Layer.effect(
        ProjectStore.ProjectStoreV2,
        Effect.gen(function* () {
          const delegate = yield* ProjectStore.ProjectStoreV2;
          return ProjectStore.ProjectStoreV2.of({
            ...delegate,
            apply: (event) =>
              delegate
                .apply(event)
                .pipe(
                  Effect.andThen(!committed && event.aggregateId === firstId ? pause : Effect.void),
                ),
          });
        }),
      ).pipe(Layer.provide(ProjectStore.layer.pipe(Layer.provide(layerDatabase))));
      const layerPausedEvents = Layer.effect(
        EventStore.EventStoreV2,
        Effect.gen(function* () {
          const delegate = yield* EventStore.EventStoreV2;
          return EventStore.EventStoreV2.of({
            ...delegate,
            publishCommitted: (events) =>
              (committed &&
              events.some((event) => "aggregateId" in event && event.aggregateId === firstId)
                ? pause
                : Effect.void
              ).pipe(Effect.andThen(delegate.publishCommitted(events))),
          });
        }),
      ).pipe(Layer.provide(layerEventStoreProvided));
      const layer = EventSink.layerFromStores.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            layerDatabase,
            layerApplicationEventsProvided,
            layerProjectionStoreProvided,
            layerPausedEvents,
            layerPausedProjects,
            layerEffectOutboxProvided,
            layerCommandReceiptStoreProvided,
            TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
        const now = yield* DateTime.now;
        const isoNow = DateTime.formatIso(now);
        const command = (projectId: ProjectId) => {
          const commandId = CommandId.make(`command:${projectId}`);
          return {
            commandId,
            projectId,
            commandType: "project.create",
            acceptedAt: now,
            event: {
              eventId: EventId.make(`event:${projectId}`),
              aggregateKind: "project" as const,
              aggregateId: projectId,
              occurredAt: isoNow,
              commandId,
              causationEventId: null,
              correlationId: commandId,
              metadata: {},
              type: "project.created" as const,
              payload: {
                projectId,
                title: projectId,
                workspaceRoot: `/tmp/${projectId}`,
                defaultModelSelection: null,
                scripts: [],
                createdAt: isoNow,
                updatedAt: isoNow,
              },
            },
          };
        };
        const first = command(firstId);
        const published = yield* applicationEvents.streamApplicationEvents().pipe(
          Stream.takeUntil((event) => "aggregateId" in event && event.aggregateId === markerId),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        const writer = yield* sink.commitProjectCommand(first).pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        writer.interruptUnsafe();
        if (committed) yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.await(writer))._tag, "Failure");
        assert.equal(Option.isSome(yield* projects.get(firstId)), committed);
        assert.equal(
          Option.isSome(yield* receipts.getProjectByCommandId(first.commandId)),
          committed,
        );
        assert.isTrue((yield* sink.commitProjectCommand(command(markerId))).committed);
        const events = Array.from(yield* Fiber.join(published));
        assert.deepEqual(
          events.map((event) => ("aggregateId" in event ? event.aggregateId : null)),
          committed ? [firstId, markerId] : [markerId],
        );
        assert.deepEqual(
          events,
          Array.from(
            yield* applicationEvents
              .readApplicationEvents({
                afterSequence: 0,
                throughSequence: yield* applicationEvents.latestApplicationSequence,
              })
              .pipe(Stream.runCollect),
          ),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(layerDatabase)),
);
