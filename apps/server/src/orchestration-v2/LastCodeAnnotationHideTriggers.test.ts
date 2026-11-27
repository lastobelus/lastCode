import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ServerSettings as ServerSettingsSchema,
  ServerSettingsPatch,
  SourceControlProviderKind,
  ThreadId,
  type AnnotationHideTriggerInput,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2InternalCommand,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  fakePullRequestProvider,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { makePausedEnvironment } from "./EnvironmentAutomation.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Triggers from "./LastCodeAnnotationHideTriggers.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const stamp = "2026-11-20T01:00:00.000Z";
const then = DateTime.makeUnsafe(stamp);
const baseline = "0.1.0-nightly.20261120.4979";
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");

const storage = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

type TriggerCommand = Extract<
  OrchestrationV2InternalCommand,
  { type: "thread.annotation.reveal" | "thread.annotation.hide-progress" }
>;

function thread(name: string): OrchestrationV2AppThread {
  const id = ThreadId.make(name);
  return {
    id,
    projectId,
    title: name,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: then,
    updatedAt: then,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
}

type StoredTriggerInput =
  | Extract<AnnotationHideTriggerInput, { kind: "date" | "pull-request-merged" }>
  | (Extract<AnnotationHideTriggerInput, { kind: "thread-archived" }> & {
      afterTargetSequence: number;
    })
  | (Extract<AnnotationHideTriggerInput, { kind: "checkpoints" }> & {
      baselineVersion: string;
      seenBuilds: readonly string[];
    });

function armed(name: string, trigger: StoredTriggerInput): OrchestrationV2AppThread {
  return {
    ...thread(name),
    annotation: {
      id: `${name}-annotation`,
      anchorMessageId: MessageId.make(`${name}-message`),
      body: "Waiting",
      createdAt: stamp,
      updatedAt: stamp,
      resolvedAt: null,
      hideUntil: { ...trigger, id: CommandId.make(`${name}-trigger`), hiddenAt: stamp },
    },
  };
}

const write = (
  value: OrchestrationV2AppThread,
  type:
    | "thread.created"
    | "thread.archived"
    | "thread.unarchived"
    | "thread.deleted"
    | "thread.annotation-upserted" = "thread.created",
) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.write({
      events: [
        {
          id: EventId.make(`${value.id}-${type}`),
          type,
          threadId: value.id,
          occurredAt: value.updatedAt,
          payload: value,
        },
      ],
    }),
  );

const makeHarness = Effect.fn(function* (rejectFirst = false) {
  const pause = yield* makePausedEnvironment;
  yield* pause.resume;
  const commands: TriggerCommand[] = [];
  const delivered = yield* Queue.unbounded<TriggerCommand>();
  const layer = Layer.mergeAll(
    pause.layer,
    NodeCrypto.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (
            command.type !== "thread.annotation.reveal" &&
            command.type !== "thread.annotation.hide-progress"
          )
            return yield* Effect.die("Unexpected command");
          commands.push(command);
          if (rejectFirst && commands.length === 1) {
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          }
          yield* Queue.offer(delivered, command);
          return { sequence: 0, storedEvents: [] };
        }),
    }),
  );
  return { layer, pause, commands, delivered };
});

const noPullRequests = Layer.mock(PullRequestService.PullRequestService)({});
const defaultSettings = ServerSettings.layerTest();

it.effect("an annotation armed after startup invalidates an idle scheduler hint", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(stamp));
    const harness = yield* makeHarness();
    const sink = yield* EventSink.EventSinkV2;
    const carrier = armed("new-date", { kind: "date", at: stamp });
    yield* write(thread(carrier.id));
    const eventConsumed = yield* Deferred.make<void>();
    const sweeps = yield* Triggers.make(baseline).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        stream: (input) =>
          input?.eventType === "thread.annotation-upserted"
            ? sink
                .stream(input)
                .pipe(
                  Stream.take(1),
                  Stream.concat(
                    Stream.fromEffect(Deferred.succeed(eventConsumed, undefined)).pipe(
                      Stream.drain,
                    ),
                  ),
                )
            : sink.stream(input),
      }),
      Effect.provide(Layer.mergeAll(harness.layer, noPullRequests, defaultSettings)),
    );
    yield* sweeps.local;
    assert.lengthOf(harness.commands, 0);
    yield* write(carrier, "thread.annotation-upserted");
    yield* Deferred.await(eventConsumed);
    yield* sweeps.local;
    expect(yield* Queue.take(harness.delivered)).toMatchObject({
      threadId: "new-date",
      outcome: "due",
    });
  }).pipe(Effect.provide(storage)),
);

it.effect("recovers the first target event and a missed date on an archived carrier", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(stamp) + 60_000);
    const harness = yield* makeHarness();
    const sink = yield* EventSink.EventSinkV2;
    const toggled = thread("toggled");
    const deleted = thread("deleted");
    const bootTarget = thread("boot-target");
    yield* write(toggled);
    yield* write(deleted);
    yield* write(bootTarget);
    for (const target of [toggled, deleted, bootTarget]) {
      yield* write(
        armed(`carrier-${target.id}`, {
          kind: "thread-archived",
          threadId: target.id,
          afterTargetSequence: yield* sink.latestSequence({ threadId: target.id }),
        }),
      );
    }
    yield* write({ ...toggled, archivedAt: then }, "thread.archived");
    yield* write(toggled, "thread.unarchived");
    yield* write({ ...toggled, deletedAt: then }, "thread.deleted");
    yield* write({ ...deleted, deletedAt: then }, "thread.deleted");
    yield* write({ ...armed("missed-date", { kind: "date", at: stamp }), archivedAt: then });
    const removed = armed("removed-carrier", { kind: "date", at: stamp });
    yield* write(removed);
    yield* write({ ...removed, deletedAt: then }, "thread.deleted");
    const parent = armed("parent", { kind: "date", at: stamp });
    yield* write(parent);
    const child = thread("child");
    yield* write({
      ...child,
      annotation: parent.annotation ?? null,
      createdAt: DateTime.makeUnsafe(Date.parse(stamp) + 1),
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });

    const bootWrite = write({ ...bootTarget, archivedAt: then }, "thread.archived");
    const sweeps = yield* Triggers.make(baseline).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        latestSequence: (input) =>
          sink.latestSequence(input).pipe(Effect.tap(() => bootWrite.pipe(Effect.orDie))),
      }),
      Effect.provide(Layer.mergeAll(harness.layer, noPullRequests, defaultSettings)),
    );
    yield* sweeps.local;
    assert.deepEqual(
      Object.fromEntries(
        harness.commands.map((command) => [
          command.threadId,
          command.type === "thread.annotation.reveal" ? command.outcome : command.type,
        ]),
      ),
      {
        "carrier-toggled": "archived",
        "carrier-deleted": "deleted",
        "carrier-boot-target": "archived",
        "missed-date": "due",
        parent: "due",
      },
    );
  }).pipe(Effect.provide(storage)),
);

it.effect(
  "resumes checkpoint progress only on a newer build and retries with a fresh command",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true);
      yield* write(
        armed("checkpoint", {
          kind: "checkpoints",
          count: 2,
          baselineVersion: baseline,
          seenBuilds: ["20261120.4979.1"],
        }),
      );
      for (const version of ["0.1.0", baseline, `${baseline}.1`]) {
        yield* Effect.scoped(
          Triggers.make(version).pipe(Effect.flatMap((worker) => worker.local)),
        ).pipe(Effect.provide(Layer.mergeAll(harness.layer, noPullRequests, defaultSettings)));
      }
      assert.lengthOf(harness.commands, 0);
      const sweeps = yield* Triggers.make("0.1.0-nightly.20261121.4980").pipe(
        Effect.provide(Layer.mergeAll(harness.layer, noPullRequests, defaultSettings)),
      );
      yield* sweeps.local;
      yield* sweeps.local;
      assert.lengthOf(harness.commands, 2);
      assert.notEqual(harness.commands[0]?.commandId, harness.commands[1]?.commandId);
      expect(yield* Queue.take(harness.delivered)).toMatchObject({
        type: "thread.annotation.hide-progress",
        threadId: "checkpoint",
        annotationId: "checkpoint-annotation",
        triggerId: "checkpoint-trigger",
      });
    }).pipe(Effect.provide(storage)),
);

const prRef = { host: "github.com", repository: "acme/web", number: 1 };
const prTrigger = { kind: "pull-request-merged", ...prRef } as const;

const fakeSummary = (number: number, state: "open" | "merged" | "closed") => ({
  provider: SourceControlProviderKind.make("github"),
  projectId,
  repository: prRef.repository,
  number,
  title: "Change request",
  url: `https://github.com/acme/web/pull/${number}`,
  state,
  headBranch: "feature",
  baseBranch: "main",
  updatedAt: stamp,
});

it.effect("a paused scheduler still fires a due date and checks an overdue PR after resume", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.pause.pause;
    yield* TestClock.setTime(Date.parse(stamp));
    yield* write(armed("future-date", { kind: "date", at: "2026-11-20T01:00:30.000Z" }));
    yield* write(armed("pr", prTrigger));
    let lookups = 0;
    const pullRequests = Layer.mock(PullRequestService.PullRequestService)({
      summary: () =>
        Effect.sync(() => {
          lookups++;
          return fakeSummary(prRef.number, "merged");
        }),
    });
    yield* Layer.build(
      Triggers.layerForVersion(baseline).pipe(
        Layer.provide(Scheduler.layer),
        Layer.provide(Layer.mergeAll(harness.layer, pullRequests, defaultSettings)),
      ),
    );
    yield* TestClock.adjust("25 seconds");
    assert.lengthOf(harness.commands, 0);
    assert.equal(lookups, 0);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Queue.take(harness.delivered)).toMatchObject({
      threadId: "future-date",
      outcome: "due",
    });
    assert.equal(lookups, 0);
    yield* harness.pause.resume;
    yield* TestClock.adjust("5 seconds");
    expect(yield* Queue.take(harness.delivered)).toMatchObject({
      threadId: "pr",
      outcome: "merged",
    });
    assert.equal(lookups, 1);
  }).pipe(Effect.provide(storage)),
);

it.effect("a PR lookup already in flight can finish while a pause holds later groups", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* write(armed("first-pr", prTrigger));
    yield* write(armed("second-pr", { ...prTrigger, number: 2 }));
    const started = yield* Deferred.make<number>();
    const release = yield* Deferred.make<void>();
    const lookedUp: number[] = [];
    const pullRequests = Layer.mock(PullRequestService.PullRequestService)({
      summary: ({ number }) =>
        Effect.gen(function* () {
          lookedUp.push(number);
          yield* Deferred.succeed(started, number);
          yield* Deferred.await(release);
          return fakeSummary(number, "merged");
        }),
    });
    const sweeps = yield* Triggers.make(baseline).pipe(
      Effect.provide(Layer.mergeAll(harness.layer, pullRequests, defaultSettings)),
    );
    const pass = yield* Effect.forkChild(sweeps.pr);
    const first = yield* Deferred.await(started);
    yield* harness.pause.pause;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pass);
    assert.deepEqual(lookedUp, [first]);
    assert.lengthOf(harness.commands, 1);
    yield* harness.pause.resume;
    yield* sweeps.pr;
    assert.deepEqual([...lookedUp].sort(), [1, 2]);
  }).pipe(Effect.provide(storage)),
);

function realPullRequestLayer(provider: PullRequestProviderApi) {
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Fixture",
    workspaceRoot: "/fixture",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web.git",
      },
      provider: SourceControlProviderKind.make("github"),
      displayName: prRef.repository,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  return PullRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([provider]),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          get: () => Effect.succeed(fakeSourceControlProvider("github")),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
          listShells: () => Effect.succeed([project]),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer,
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

it.effect(
  "uses fresh grouped PR summaries and honors a changed interval and unreadable retry floor",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* TestClock.setTime(Date.parse(stamp));
      const linked = armed("linked", prTrigger);
      yield* write({
        ...linked,
        linkedPullRequest: {
          projectId,
          repository: prRef.repository,
          number: prRef.number,
          url: "https://github.com/acme/web/pull/1",
        },
      });
      yield* write(armed("unlinked", prTrigger));
      yield* write(armed("unreadable", { ...prTrigger, number: 2 }));
      const verdict = yield* Deferred.make<void>();
      const newSettings = yield* Deferred.make<typeof DEFAULT_SERVER_SETTINGS>();
      const settingsConsumed = yield* Deferred.make<void>();
      const interval = yield* Ref.make(30);
      const settings = Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(interval).pipe(
          Effect.map((minutes) => ({
            ...DEFAULT_SERVER_SETTINGS,
            lastcodeAnnotationPrCheckMinutes: minutes,
          })),
        ),
        subscribeChanges: Effect.succeed(
          Stream.fromEffect(Deferred.await(newSettings)).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(settingsConsumed, undefined)).pipe(Stream.drain),
            ),
          ),
        ),
      });
      const reads = { first: 0, second: 0 };
      const provider = fakePullRequestProvider("github", {
        getChangeRequestSummary: ({ number, cwd, host, repository }) =>
          Effect.gen(function* () {
            assert.deepEqual(
              { cwd, host, repository },
              { cwd: "/fixture", host: prRef.host, repository: prRef.repository },
            );
            const done = yield* Deferred.isDone(verdict);
            if (number === 1) reads.first++;
            else {
              reads.second++;
              if (!done) {
                return yield* new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation: "summary",
                  reason: "failed",
                  detail: "HTTP 404",
                });
              }
            }
            return fakeSummary(number, done ? (number === 1 ? "merged" : "closed") : "open");
          }),
      });
      yield* Effect.gen(function* () {
        const pullRequests = yield* PullRequestService.PullRequestService;
        assert.equal((yield* pullRequests.summary({ projectId, ...prRef })).state, "open");
        const sweeps = yield* Triggers.make(baseline);
        yield* sweeps.pr;
        assert.deepEqual(reads, { first: 2, second: 1 });
        yield* TestClock.adjust("1 minute");
        yield* sweeps.pr;
        assert.deepEqual(reads, { first: 2, second: 1 });

        yield* Ref.set(interval, 2);
        yield* Deferred.succeed(newSettings, {
          ...DEFAULT_SERVER_SETTINGS,
          lastcodeAnnotationPrCheckMinutes: 2,
        });
        yield* Deferred.await(settingsConsumed);
        yield* sweeps.pr;
        assert.deepEqual(reads, { first: 2, second: 1 });
        yield* Deferred.succeed(verdict, undefined);
        yield* TestClock.adjust("1 minute");
        yield* sweeps.pr;
        assert.deepEqual(reads, { first: 3, second: 1 });
        assert.deepEqual(harness.commands.map((command) => command.threadId).sort(), [
          "linked",
          "unlinked",
        ]);
        for (const command of harness.commands)
          expect(command).toMatchObject({ outcome: "merged" });
        yield* TestClock.adjust("13 minutes");
        yield* sweeps.pr;
        assert.deepEqual(reads, { first: 3, second: 2 });
        expect(harness.commands.at(-1)).toMatchObject({
          threadId: "unreadable",
          outcome: "closed-unmerged",
        });
      }).pipe(
        Effect.provide(
          realPullRequestLayer(provider).pipe(
            Layer.provideMerge(Layer.mergeAll(harness.layer, settings)),
          ),
        ),
      );
    }).pipe(Effect.provide(storage)),
);

it.effect("stores the independent PR interval with the existing minute bounds", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    assert.equal((yield* settings.getSettings).lastcodeAnnotationPrCheckMinutes, 15);
    const decode = Schema.decodeEffect(ServerSettingsPatch);
    for (const minutes of [0, 1.5, 1441]) {
      yield* decode({ lastcodeAnnotationPrCheckMinutes: minutes }).pipe(Effect.flip);
    }
    yield* settings.updateSettings(yield* decode({ lastcodeAnnotationPrCheckMinutes: 7 }));
    yield* settings.updateSettings({ lastcodePullRequestWatchQuietMinutes: 90 });
    const saved = yield* fs
      .readFileString(config.settingsPath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ServerSettingsSchema))));
    expect(saved).toMatchObject({
      lastcodeAnnotationPrCheckMinutes: 7,
      lastcodePullRequestWatchQuietMinutes: 90,
    });
    assert.equal((yield* settings.getSettings).lastcodeAnnotationPrCheckMinutes, 7);
  }).pipe(
    Effect.provide(
      ServerSettings.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(Sqlite.layerMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-annotation-trigger-settings-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
