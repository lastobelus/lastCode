// @effect-diagnostics nodeBuiltinImport:off - a directory junction needs no privilege on Windows.
import * as NodeFSP from "node:fs/promises";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { ThreadReadAuthorization } from "../../../orchestration-v2/ThreadReadAuthorization.ts";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  GitCommandError,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  type ServerProvider,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ModelSelection,
  type ProjectScript,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as DocumentText from "../../../provider/DocumentText.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  OrchestratorRuntimeModeAboveCeilingError,
} from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as AuthSessions from "../../../persistence/AuthSessions.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SourceControlProviderRegistry from "../../../sourceControl/SourceControlProviderRegistry.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadReadBroker from "../../ThreadReadBroker.ts";
import * as ThreadReadAuthority from "../../../threadReadAuthority/Store.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect.each(["resolved", "unresolved", "absent"] as const)(
  "keeps a launched first message tied to the requesting run when its parent advances (%s attribution)",
  (attribution) =>
    Effect.gen(function* () {
      const sourceThreadId = ThreadId.make("source-thread");
      const projectId = ProjectId.make("project");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
      const database = SqlitePersistence.layerMemory;
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId: providerInstanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("The launch fixture does not execute providers"),
        },
      ]);
      const orchestration = ProviderReplayHarness.layerWithRegistry(
        { name: "project-launch-authority" },
        registry,
        { databaseLayer: database, runEffectWorker: false },
      );
      const context = yield* Layer.mergeAll(
        database,
        AuthSessions.layer.pipe(Layer.provide(database)),
        ThreadManagement.layer.pipe(Layer.provide(orchestration)),
        ProjectionStore.layer.pipe(Layer.provide(database)),
        orchestration,
      ).pipe(Layer.build);
      const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
      const acceptedThreads = Context.get(context, ThreadManagement.ThreadManagementService);
      const sessions = Context.get(context, AuthSessions.AuthSessionRepository);
      // When set, another client's input starts after the tool has loaded its caller.
      let advanceAfterCallerLoads = false;
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
        getThreadRecords: (threadId, fields, filter) =>
          Effect.gen(function* () {
            const records = yield* acceptedThreads.getThreadRecords(threadId, fields, filter);
            if (threadId === sourceThreadId && advanceAfterCallerLoads) {
              advanceAfterCallerLoads = false;
              yield* submit("between-client-session", sourceThreadId, "between-run");
            }
            return records;
          }),
      });
      const broker = yield* ThreadReadBroker.ThreadReadBroker.pipe(
        Effect.provide(
          ThreadReadBroker.layer.pipe(
            Layer.provide(threads),
            Layer.provide([NodeCrypto.layer, Layer.succeedContext(context)]),
          ),
        ),
      );
      const now = yield* DateTime.now;
      for (const sessionId of [
        "requester-session",
        "between-client-session",
        "another-client-session",
      ]) {
        yield* sessions.create({
          sessionId: AuthSessionId.make(sessionId),
          subject: "paired-client",
          method: "browser-session-cookie",
          scopes: ["orchestration:read"],
          issuedAt: now,
          expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 86_400_000),
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "unknown",
            os: null,
            browser: null,
          },
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId,
        title: "Source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const submit = (sessionId: string, threadId: ThreadId, runId: string) =>
        Effect.gen(function* () {
          const messageId = MessageId.make(`${runId}-message`);
          const before = yield* acceptedThreads.getThreadRecords(threadId, ["runs"]);
          if (before.runs.length > 0) {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`stop:${runId}`),
              threadId,
            });
          }
          const threadReadIntent = yield* broker
            .forSession(sessionId)
            .authorize(threadId, messageId);
          expect(threadReadIntent).toBeDefined();
          yield* orchestrator.dispatch(
            {
              type: "message.dispatch",
              commandId: CommandId.make(`accept:${runId}`),
              threadId,
              messageId,
              text: "Launch a thread",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            },
            threadReadIntent === undefined ? undefined : { threadReadIntent },
          );
          const records = yield* acceptedThreads.getThreadRecords(threadId, ["runs"]);
          return records.runs.find((run) => run.userMessageId === messageId)!;
        });
      const activeRun = yield* submit("requester-session", sourceThreadId, "active-run");
      const requesterRequests = yield* broker.connect("requester-session");
      let caller = {
        id: sourceThreadId,
        projectId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        activeRunId: activeRun.id,
        lineage: { rootThreadId: sourceThreadId, parentThreadId: null, relationshipToParent: null },
        archivedAt: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell;
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      let expectLaunchAuthority = true;
      const invocationScope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      };
      const layerDependencies = Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(ThreadReadBroker.ThreadReadBroker, broker),
        threads,
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.gen(function* () {
              // Another client advances the parent while the launch prepares.
              yield* submit("another-client-session", sourceThreadId, "later-run");
              const threadId = input.threadId!;
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`create:${threadId}`),
                threadId,
                projectId,
                title: input.title,
                modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: null,
                worktreePath: null,
                createdBy: "agent",
                creationSource: "mcp",
              });
              if (input.initialMessage?.messageId !== undefined) {
                const authorization = yield* ThreadReadAuthorization;
                const threadReadIntent = yield* authorization.authorize(
                  threadId,
                  input.initialMessage.messageId,
                );
                if (expectLaunchAuthority) expect(threadReadIntent).toBeDefined();
                else expect(threadReadIntent).toBeUndefined();
                yield* orchestrator.dispatch(
                  {
                    type: "message.dispatch",
                    commandId: CommandId.make(`prompt:${threadId}`),
                    threadId,
                    messageId: input.initialMessage.messageId,
                    text: input.initialMessage.text,
                    attachments: [],
                    dispatchMode: { type: "start_immediately" },
                    createdBy: "agent",
                    creationSource: "mcp",
                  },
                  threadReadIntent === undefined ? undefined : { threadReadIntent },
                );
              }
              return {
                threadId,
                projection: yield* orchestrator.getThreadProjection(threadId),
                resumed: false,
              } satisfies ThreadLaunch.ThreadLaunchResult;
            }).pipe(Effect.orDie);
          },
        }),
        Layer.mock(DocumentText.DocumentText)({}),
        Layer.mock(Project.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    id,
                    workspaceRoot: "/projects/source",
                    defaultModelSelection: modelSelection,
                  } as unknown as ProjectRecord)
                : Option.none(),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      );
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      advanceAfterCallerLoads = true;
      const result = yield* toolkit
        .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
      expect(advanceAfterCallerLoads).toBe(false);
      expect(launched[0]?.initialMessage?.senderThreadId).toBe(sourceThreadId);
      expect(launched[0]?.creatorThreadId).toBe(sourceThreadId);
      const prompted = launched[0]!;
      const launchedProjection = yield* acceptedThreads.getThreadRecords(prompted.threadId!, [
        "runs",
      ]);
      const launchedRun = launchedProjection.runs.find(
        (run) => run.userMessageId === prompted.initialMessage!.messageId,
      )!;
      // Only the requester's client is connected; reaching it yields a search miss.
      yield* requesterRequests.pipe(
        Stream.runForEach((request) =>
          broker.respond("requester-session", {
            connectionId: request.connectionId,
            requestId: request.requestId,
            result: null,
            unavailableEnvironmentIds: [],
          }),
        ),
        Effect.forkScoped,
      );
      expect(
        yield* broker
          .read(prompted.threadId!, launchedRun.id, {
            threadId: ThreadId.make("remote-thread"),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "thread_not_found" });
      const unprompted = { title: "Independent notes", creatorThreadId: "untrusted-creator" };
      caller = {
        ...caller,
        lineage: {
          rootThreadId: sourceThreadId,
          parentThreadId: null,
          relationshipToParent: "fork",
          sideChat: true,
        },
      };
      yield* toolkit
        .handle("t3_thread_launch", unprompted)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      expect(launched[0]?.groupThread).toBeUndefined();
      expect(launched[1]?.initialMessage).toBeUndefined();
      expect(launched[1]?.groupThread).toBe(true);
      expect(launched[1]?.creatorThreadId).toBe(sourceThreadId);
      expect(launched[1]?.groupedUnderThreadId).toBeNull();
      expect(launched[1]).toMatchObject({
        creatorOrigin: { kind: "thread_launch", threadId: sourceThreadId, owned: true },
      });

      // A's accepted input retains its own authority after another client's run B starts.
      const store = Context.get(context, ProjectionStore.ProjectionStoreV2);
      const providerSessionId = ProviderSessionId.make("runtime-session");
      const requester = yield* acceptedThreads.getThreadRecords(sourceThreadId, [
        "attempts",
        "providerThreads",
      ]);
      const attempt = requester.attempts.find((attempt) => attempt.runId === activeRun.id)!;
      const nativeThread = requester.providerThreads.find(
        (thread) => thread.id === attempt.providerThreadId,
      )!;
      expect(attempt).toBeDefined();
      expect(nativeThread).toBeDefined();
      yield* store.apply({
        id: EventId.make("requester-session-attached"),
        type: "provider-session.attached",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "ready",
          cwd: "/projects/source",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          extensionStatuses: [],
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* store.apply({
        id: EventId.make("requester-provider-thread-updated"),
        type: "provider-thread.updated",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          ...nativeThread,
          providerSessionId,
        },
      });
      const authority = yield* ThreadReadAuthority.make.pipe(
        Effect.provide(Layer.succeedContext(context)),
      );
      yield* broker.connect("another-client-session").pipe(Effect.asVoid);
      const currentRun = yield* submit(
        "another-client-session",
        sourceThreadId,
        `current-${attribution}`,
      );
      caller = { ...caller, activeRunId: currentRun.id, latestRunId: currentRun.id };
      const records = yield* acceptedThreads.getThreadRecords(sourceThreadId, ["runs"]);
      expect(records.runs.find((run) => run.id === activeRun.id)?.completedAt).not.toBeNull();
      expect((yield* authority.lookupGrant(sourceThreadId, "run", activeRun.id))?.sessionId).toBe(
        "requester-session",
      );
      expect((yield* authority.lookupGrant(sourceThreadId, "run", currentRun.id))?.sessionId).toBe(
        "another-client-session",
      );
      expectLaunchAuthority = attribution !== "unresolved";
      yield* toolkit
        .handle("t3_thread_launch", { title: `Audit ${attribution}`, message: "Review the change" })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocationScope,
            thread: {
              ...invocationScope.thread!,
              attribution,
              ...(attribution === "absent"
                ? {}
                : { execution: { runId: activeRun.id, attemptId: attempt.id } }),
            },
          }),
          Effect.provide(layerDependencies),
        );
      const child = launched.at(-1)!;
      const childRecords = yield* acceptedThreads.getThreadRecords(child.threadId!, ["runs"]);
      const childRun = childRecords.runs.find(
        (run) => run.userMessageId === child.initialMessage!.messageId,
      )!;
      const grant = yield* authority.lookupGrant(child.threadId!, "run", childRun.id);
      expect(grant?.sessionId).toBe(
        attribution === "resolved"
          ? "requester-session"
          : attribution === "absent"
            ? "another-client-session"
            : undefined,
      );
    }).pipe(Effect.scoped),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly linked?: boolean;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly defaultThreadEnvMode?: "local" | "worktree";
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly overrideScripts?: readonly ProjectScript[];
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly hostedAppUrl?: string;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
  readonly refusedPlacement?: { value: boolean };
  readonly launchError?: (input: ThreadLaunch.ThreadLaunchInput) => ThreadLaunch.ThreadLaunchError;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input.providers ?? []),
      refreshWorkspaceSnapshot: () => Effect.succeed(input.providers ?? []),
    }),
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.newWorktreesStartFromOrigin === undefined
        ? {}
        : { newWorktreesStartFromOrigin: input.newWorktreesStartFromOrigin }),
      ...(input.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: {
                defaultModelSelection: input.overrideModel,
                ...(input.overrideScripts === undefined
                  ? {}
                  : { defaultProjectScripts: input.overrideScripts }),
              },
            },
          }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
        ...(input.linked === undefined ? {} : { linked: input.linked }),
        hostedAppUrl: input.hostedAppUrl,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // A thread exists once a launch started it.
      getThreadShell: (threadId) => {
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: launch.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        if (input.launchError !== undefined) return Effect.fail(input.launchError(launch));
        if (input.refusedByCeiling) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorRuntimeModeAboveCeilingError({
                commandId: launch.commandId,
                threadId: launch.threadId ?? ThreadId.make("thread:refused"),
                refused: "mode",
                runtimeMode: launch.runtimeMode,
                maxRuntimeMode: "approval-required",
                organization: "Example Corp",
              }),
            }),
          );
        }
        if (input.refusedPlacement?.value && launch.groupedUnderThreadId != null) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorDispatchError({
                commandId: launch.commandId,
                commandType: "thread.create",
                cause: new OrchestratorDispatchError({
                  commandId: launch.commandId,
                  commandType: "thread.create",
                  field: "groupedUnderThreadId",
                  cause: "The parent is not available for grouping.",
                }),
              }),
            }),
          );
        }
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
      workspaceScanDirectory: Effect.succeed,
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { projectId, modelSelection, projectDefaults, dependencies: layerDependencies };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly generateTitle?: boolean;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly hostedAppUrl?: string;
          readonly refusedByCeiling?: true;
          readonly delegated?: true;
        },
      ) {
        const { targeted, overrideModel, hostedAppUrl, refusedByCeiling, delegated, ...input } =
          params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          ...(delegated === undefined ? {} : { linked: delegated }),
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
          ...(refusedByCeiling === undefined ? {} : { refusedByCeiling }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", {
            ...input,
            ...(targeted === false ? {} : { projectId }),
            ...(delegated === true
              ? {
                  remotePreparation: {
                    parentEnvironmentId: EnvironmentId.make("parent-environment"),
                    parentThreadId: ThreadId.make("parent-thread"),
                    sourceTaskId: NodeId.make("source-task"),
                  },
                }
              : {}),
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](t3-thread://v2/environment/${encodeURIComponent(belowCeiling.launched[0]!.threadId!)})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
      expect(belowCeiling.launched[0]?.generateTitle).toBeUndefined();
      expect(belowCeiling.launched[0]?.titleRenamed).toBe(true);

      const titled = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        generateTitle: true,
        message: "Fix the bug",
      });
      expect(titled.launched[0]).toMatchObject({ title: "Fix", generateTitle: true });
      expect(titled.launched[0]?.titleRenamed).toBeUndefined();

      for (const message of [undefined, "", " \n "]) {
        const idleTitled = yield* launchWith("full-access", "full-access", {
          title: "Fix",
          generateTitle: true,
          ...(message === undefined ? {} : { message }),
        });
        expect(idleTitled.result).toMatchObject({ code: "invalid_request" });
        expect(idleTitled.launched).toHaveLength(0);
      }

      const delegated = yield* launchWith("full-access", "approval-required", {
        title: "Delegated task",
        delegated: true,
      });
      expect(delegated.launched[0]?.runtimeMode).toBe("full-access");

      const cappedDelegation = yield* launchWith("auto-accept-edits", "approval-required", {
        title: "Restricted delegated task",
        delegated: true,
      });
      expect(cappedDelegation.launched[0]?.runtimeMode).toBe("auto-accept-edits");

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        hostedAppUrl: "https://t3.example.com",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://t3.example.com/threads/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
      });

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);

      // An administrator's ceiling the orchestrator enforces is named, not reported as unavailable.
      const managed = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        refusedByCeiling: true,
      });
      expect(managed.result).toMatchObject({
        code: "invalid_request",
        message: "Example Corp limits threads to Supervised.",
      });
    }),
);

it.effect("launch names a rejected request key and hides internal causes", () =>
  Effect.gen(function* () {
    for (const cause of ["thread.create", "message.dispatch", "internal"] as const) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "full-access",
        launched,
        launchError: (input) =>
          new ThreadLaunch.ThreadLaunchError({
            operation: "create-thread",
            commandId: input.commandId,
            projectId: input.projectId,
            cause:
              cause === "internal"
                ? new OrchestratorDispatchError({
                    commandId: input.commandId,
                    commandType: "thread.create",
                    cause: new Error("private-storage-path"),
                  })
                : new OrchestratorCommandPreviouslyRejectedError({
                    commandId: input.commandId,
                    commandType: cause,
                    detail: "private-storage-path",
                  }),
          }),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const results = yield* toolkit
        .handle("t3_thread_launch", {
          title: "Inspection",
          projectId,
          clientRequestId: "rejected-creation",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(results.at(-1)?.result).toMatchObject(
        cause === "thread.create"
          ? {
              code: "invalid_request",
              message:
                "This clientRequestId belongs to an earlier request that was rejected. Correct the input, then retry with a new clientRequestId.",
            }
          : { code: "orchestration_error", message: "The operation could not be completed." },
      );
    }
  }).pipe(Effect.scoped),
);

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    // Pi offers no Auto; a mode a provider lacks would run as Supervised.
    const pi = ProviderInstanceId.make("pi");
    const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers: [
          {
            instanceId: pi,
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
        ],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          projectId,
          title: "Fix",
          modelSelection: { instanceId: pi, model: "pi-model" },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return { result: result.at(-1)?.result, launched };
    });

    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it.effect("a launch with a model its provider does not advertise creates no thread", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [
        driver === "claudeAgent"
          ? {
              slug: "claude-opus",
              name: "Opus",
              aliases: ["opus"],
              isCustom: false,
              capabilities: null,
            }
          : { slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
      // The project folder's own provider config adds a model the machine catalog lacks.
      workspaceSnapshots:
        driver === "codex"
          ? [
              {
                cwd: "/projects/client-target",
                checkedAt: "2026-01-01T00:00:00Z",
                slashCommands: [],
                skills: [],
                models: [
                  { slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null },
                  { slug: "folder-local", name: "Local", isCustom: false, capabilities: null },
                ],
              },
            ]
          : [],
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchWith = (instanceId: string, model: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((result) => result.at(-1)?.result),
          Effect.provide(dependencies),
        );

    for (const [instanceId, model] of [
      ["claudeAgent", "claude-unadvertised"],
      ["codex", "opus"],
    ] as const) {
      expect(yield* launchWith(instanceId, model)).toMatchObject({
        code: "model_unavailable",
        message: expect.stringContaining(
          `Model ${model} is not advertised by provider ${instanceId}. Advertised models: `,
        ),
      });
    }
    expect(launched).toHaveLength(0);

    expect(yield* launchWith("claudeAgent", "Opus")).toMatchObject({
      modelSelection: { instanceId: "claudeAgent", model: "Opus" },
    });
    expect(yield* launchWith("codex", "folder-local")).toMatchObject({
      modelSelection: { instanceId: "codex", model: "folder-local" },
    });
    expect(launched).toHaveLength(2);
  }),
);

it.effect(
  "a launch rejects options its model does not declare and normalizes legacy ultracode effort",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const providers: ServerProvider[] = [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          version: null,
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00Z",
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    role: "reasoning",
                    label: "Effort",
                    type: "select",
                    options: [
                      { id: "high", label: "High" },
                      { id: "xhigh", label: "Extra High" },
                    ],
                  },
                  { id: "ultracode", label: "Ultracode", type: "boolean" },
                ],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers,
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const launchWith = (options: NonNullable<ModelSelection["options"]>) =>
        toolkit
          .handle("t3_thread_launch", {
            title: "Options check",
            projectId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-opus-5-5",
              options,
            },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((result) => result.at(-1)?.result),
            Effect.provide(dependencies),
          );

      expect(yield* launchWith([{ id: "thought_level", value: "high" }])).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("Unknown option thought_level"),
      });
      expect(launched).toHaveLength(0);

      yield* launchWith([{ id: "effort", value: "ultracode" }]);
      expect(launched.map((launch) => launch.modelSelection.options)).toEqual([
        [
          { id: "effort", value: "xhigh" },
          { id: "ultracode", value: true },
        ],
      ]);
    }),
);

it.effect("only a full-access client may pick the agent's own mode at launch", () =>
  Effect.gen(function* () {
    const agent = ProviderInstanceId.make("acp-agent");
    const launchAs = (runtimeModeCeiling: "approval-required" | "full-access") =>
      Effect.gen(function* () {
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          launched,
          providers: [
            {
              instanceId: agent,
              driver: ProviderDriverKind.make("acpRegistry"),
              enabled: true,
              installed: true,
              status: "ready",
              version: null,
              auth: { status: "authenticated" },
              checkedAt: "2026-01-01T00:00:00Z",
              models: [
                {
                  slug: "default",
                  name: "Default",
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "_t3/session-mode",
                        label: "Mode",
                        type: "select",
                        options: [
                          { id: "default", label: "Default" },
                          { id: "yolo", label: "YOLO" },
                        ],
                        currentValue: "default",
                      },
                    ],
                  },
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", {
            projectId,
            title: "Fix",
            message: "Fix the bug",
            modelSelection: {
              instanceId: agent,
              model: "default",
              options: [{ id: "_t3/session-mode", value: "yolo" }],
            },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((collected) => collected.at(-1)?.result),
            Effect.provide(dependencies),
          );
        return { result, launched };
      });

    const supervised = yield* launchAs("approval-required");
    expect(supervised.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(supervised.launched).toHaveLength(0);

    const fullAccess = yield* launchAs("full-access");
    expect(fullAccess.launched.map((launch) => launch.modelSelection.options)).toEqual([
      [{ id: "_t3/session-mode", value: "yolo" }],
    ]);
  }),
);

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }),
);

it.effect("a launch key of any length or content gives a short id and never a defect", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string) =>
      toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    // Percent-encoding would grow this six times; scratch folders are named from the id.
    yield* launch("\u00e9".repeat(256));
    expect(launched.map((input) => input.commandId)).toEqual([
      expect.stringMatching(/^mcp:launch:[0-9a-f]{64}$/),
    ]);

    const loneSurrogate = yield* launch("key-\ud800").pipe(Effect.exit);
    expect(Exit.isFailure(loneSurrogate) && Cause.hasDies(loneSurrogate.cause)).toBe(false);
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId: "fix-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Git registers resolved paths, and a launch keeps the registered one.
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" }),
    );
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    const alias = path.join(root, "alias");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string, clientRequestId?: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree, "existing-checkout")).at(-1)?.result).toMatchObject({
      projectId,
    });
    expect((yield* launchInto(outside, "existing-checkout")).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    // The thread keeps the registered worktree path when launched through a link to it.
    yield* Effect.promise(() => NodeFSP.symlink(worktree, alias, "junction"));
    expect((yield* launchInto(alias)).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
      { type: "existing_worktree", worktreePath: worktree },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type !== "worktree"
          ? Effect.void
          : workspaceStrategy.baseRef === "t3/renamed"
            ? Effect.fail(
                new ThreadLaunch.ThreadLaunchBaseRefError({
                  projectId,
                  projectTitle: "Client target",
                  workspaceRoot: "/projects/client-target",
                  baseRef: workspaceStrategy.baseRef,
                }),
              )
            : workspaceStrategy.branch === "feature/taken"
              ? Effect.fail(
                  new ThreadLaunch.ThreadLaunchBranchExistsError({
                    projectId,
                    projectTitle: "Client target",
                    branch: workspaceStrategy.branch,
                  }),
                )
              : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string, branch?: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef,
            ...(branch === undefined ? {} : { branch }),
            startFromOrigin: false,
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created. Pass a branch, tag, or commit that exists there',
    );
    expect((yield* launchFrom("main", "feature/taken")).at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "feature/taken" already exists in project "Client target". No thread was created. Pass a branch name that does not exist yet, or omit branch to get a generated name.',
    });
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a worktree launch that omits startFromOrigin follows the new-worktree setting", () =>
  Effect.gen(function* () {
    const cases = [
      { setting: true, given: undefined, expected: true },
      { setting: false, given: undefined, expected: false },
      { setting: true, given: false, expected: false },
    ];
    for (const { setting, given, expected } of cases) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const checked: Array<ThreadLaunch.ThreadLaunchInput["workspaceStrategy"]> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        newWorktreesStartFromOrigin: setting,
        checkWorktreeBase: ({ workspaceStrategy }) =>
          Effect.sync(() => {
            checked.push(workspaceStrategy);
          }),
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: "main",
            ...(given === undefined ? {} : { startFromOrigin: given }),
          },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

      const strategy = { type: "worktree", baseRef: "main", startFromOrigin: expected };
      expect(checked).toEqual([strategy]);
      expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([strategy]);
    }
  }),
);

it.effect("a launch that omits its workspace follows the new-threads-in-a-worktree default", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const source of ["setting", "t3.json"] as const) {
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-env-mode-" });
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        workspaceRoot: repo,
        ...(source === "setting" ? { defaultThreadEnvMode: "worktree" as const } : {}),
      });
      const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ]) {
        yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
      }
      if (source === "t3.json")
        yield* fileSystem.writeFileString(
          `${repo}/t3.json`,
          JSON.stringify({ defaultThreadEnvMode: "worktree" }),
        );
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      for (const workspaceStrategy of [undefined, { type: "root" as const }]) {
        yield* toolkit
          .handle("t3_thread_launch", {
            title: "Fix",
            projectId,
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      }

      expect(
        launched.map((launch) => launch.workspaceStrategy.type),
        source,
      ).toEqual(["worktree", "root"]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a defaulted worktree launch stays shared only when Git says HEAD has no commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const commitArgs = ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty"];
    for (const [checkout, expected] of [
      ["not a repository", "root"],
      ["no commit yet", "root"],
      ["branch tip object missing", "worktree"],
      ["git refuses the repository", "refused"],
    ] as const) {
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-head-" });
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        workspaceRoot: repo,
        defaultThreadEnvMode: "worktree",
      });
      const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
      if (checkout !== "not a repository")
        yield* git.execute({
          operation: "test.setupRepo",
          cwd: repo,
          args: ["init", "-b", "main"],
        });
      if (checkout === "branch tip object missing")
        yield* fileSystem.writeFileString(`${repo}/.git/refs/heads/main`, `${"1".repeat(40)}\n`);
      if (checkout === "git refuses the repository") {
        yield* git.execute({
          operation: "test.setupRepo",
          cwd: repo,
          args: [...commitArgs, "-m", "init"],
        });
        // Git quotes the broken file's path in its refusal; that path must not read as "not a repository".
        yield* fileSystem.writeFileString(`${repo}/not a git repository`, "[core\n");
        yield* fileSystem.writeFileString(
          `${repo}/.git/config`,
          `[include]\n\tpath = ${repo}/not a git repository\n`,
        );
      }
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = (yield* toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result;

      if (expected === "refused") {
        expect(result, checkout).toMatchObject({ code: "orchestration_error" });
        expect(launched, checkout).toHaveLength(0);
      } else {
        expect(
          launched.map((launch) => launch.workspaceStrategy.type),
          checkout,
        ).toEqual([expected]);
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its branch collides", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchBranchConflictError({
            projectId,
            projectTitle: "Client target",
            branch: workspaceStrategy.branch ?? "",
            conflictingBranch: "werkstatt",
          }),
        ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const refused = (yield* toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "werkstatt/baseline" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies))).at(-1)?.result;

    expect(refused).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "werkstatt/baseline" cannot be created in project "Client target": branch "werkstatt" exists. No thread was created. Use a name that does not nest under or contain an existing branch, such as "werkstatt-baseline".',
    });
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a launch into an unknown project says the project was not found", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    for (const workspaceStrategy of [
      undefined,
      { type: "worktree", baseRef: "main", startFromOrigin: false } as const,
    ]) {
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          message: "Fix the bug",
          projectId: ProjectId.make("current"),
          modelSelection,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(result.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        message: "The project was not found.",
      });
    }
    expect(launched).toHaveLength(0);
  }),
);

it.effect(
  "a launch reports an unknown grouping parent and preserves null placement and retries",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const refusedPlacement = { value: false };
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        refusedPlacement,
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const launch = (groupedUnderThreadId: ThreadId | null, clientRequestId?: string) =>
        toolkit
          .handle("t3_thread_launch", {
            title: "Fix",
            projectId,
            groupedUnderThreadId,
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

      for (const parentId of ["null", "missing-parent"]) {
        const result = (yield* launch(ThreadId.make(parentId))).at(-1)?.result;
        expect(result).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("groupedUnderThreadId"),
        });
        expect(result).toMatchObject({ message: expect.stringContaining("JSON null") });
      }
      expect(launched).toHaveLength(0);

      yield* launch(null);
      expect(launched[0]?.groupedUnderThreadId).toBeNull();
      const parentId = launched[0]!.threadId!;
      yield* launch(parentId, "grouped-child");
      expect(launched[1]?.groupedUnderThreadId).toBe(parentId);
      const childId = launched[1]!.threadId;

      launched.splice(0, 1);
      expect((yield* launch(parentId, "grouped-child")).at(-1)?.result).toMatchObject({
        threadId: childId,
      });
      expect(launched.at(-1)?.threadId).toBe(childId);
      refusedPlacement.value = true;
      const refused = (yield* launch(childId!)).at(-1)?.result;
      expect(refused).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("groupedUnderThreadId"),
      });
      expect(refused).toMatchObject({ message: expect.stringContaining("JSON null") });
    }),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a client launches with the fallback for an exhausted default", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const fallbackModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...(driver === "claudeAgent"
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
            },
          }
        : {}),
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      fallbackModel,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Fallback",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      modelSelection: fallbackModel,
    });
    expect(launched[0]?.modelSelection).toEqual(fallbackModel);
  }),
);

it.effect("creating a project through MCP refuses a model default instead of dropping it", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        create: () => Effect.die("the project was created without its model default"),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_create", {
        title: "client-target",
        workspaceRoot: "/projects/client-target",
        defaultModelSelection: harness.modelSelection,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("t3_project_update"),
    });
  }),
);

it.effect("an agent's clone is not cut off while git is still transferring", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-clone-" });
    const destinationPath = path.join(parent, "repo");
    const started = yield* Deferred.make<void>();
    const transferred = yield* Deferred.make<void>();
    const { dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched: [],
    });
    const repositories = Repositories.layer.pipe(
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          invalidateRefs: () => Effect.void,
          // Like the real driver, the clone fails once it outlives the deadline it was given.
          execute: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(transferred)),
              Effect.as({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
              Effect.timeoutOrElse({
                duration: input.timeoutMs ?? Infinity,
                orElse: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git",
                      cwd: input.cwd,
                      detail: "Git command timed out.",
                    }),
                  ),
              }),
            ),
        }),
      ),
      Layer.provideMerge(dependencies),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(repositories)),
      ),
    );

    const clone = yield* toolkit
      .handle("t3_project_clone", { remoteUrl: "https://example.test/repo.git", destinationPath })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(repositories), Effect.forkChild);
    yield* Deferred.await(started);
    // A large repository over a slow link; agents' MCP calls get a far longer budget.
    yield* TestClock.adjust("10 minutes");
    yield* Deferred.succeed(transferred, undefined);

    expect((yield* Fiber.join(clone)).at(-1)?.result).toMatchObject({ cwd: destinationPath });
  }).pipe(Effect.provide(NodeServices.layer)),
);

const deletedProject = (id: ProjectId) => ({
  id,
  title: "client-target",
  workspaceRoot: "/projects/client-target",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input, onCommitted = Effect.void) =>
            onCommitted.pipe(Effect.as(deletedProject(input.projectId))),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          discard: (projectId) => Effect.sync(() => void discarded.push(projectId)),
        }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(discarded).toEqual([harness.projectId]);
  }),
);

it.effect("an agent cannot delete the built-in scratch project, even with force", () =>
  Effect.gen(function* () {
    const deleted: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: (projectId) => Effect.succeed(projectId === harness.projectId),
        }),
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.sync(() => {
              deleted.push(input.projectId);
              return deletedProject(input.projectId);
            }),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ discard: () => Effect.void }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId, force: true })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(deleted).toEqual([]);
    expect(refused.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/scratch|no project/i),
    });
  }),
);

it.effect("reading a project shows the default model and actions saved in Settings", () =>
  Effect.gen(function* () {
    const overrideModel = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet",
    };
    const overrideScripts = [
      { id: "test", name: "Test", command: "pnpm test", icon: "test", runOnWorktreeCreate: false },
    ] satisfies ProjectScript[];
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      overrideModel,
      overrideScripts,
      launched: [],
    });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({
            id: projectId,
            title: "Client target",
            workspaceRoot: "/projects/client-target",
            defaultModelSelection: null,
            scripts: [
              {
                id: "stale",
                name: "Stale",
                command: "true",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const read = yield* toolkit
      .handle("t3_project_read", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(read.at(-1)?.result).toMatchObject({
      defaultModelSelection: overrideModel,
      scripts: overrideScripts,
    });
  }),
);

it.effect("a project update or create that is refused tells the agent why", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const detail = "Project monograms must contain at most two characters.";
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.fail(new Project.ProjectInvalidError({ projectId: input.projectId, detail })),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("t3_project_update", {
        projectId: harness.projectId,
        projectIcon: { kind: "monogram", text: "ABC", color: "blue" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request", message: detail });

    // A project started from its title has no folder yet for tracked folders to be checked against.
    const dropped = yield* toolkit
      .handle("t3_project_create", {
        title: "Wrapper",
        trackedFolders: [{ path: "/repos/api", name: "api" }],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(dropped.at(-1)?.result).toMatchObject({ code: "invalid_request" });
  }),
);
