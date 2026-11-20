import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as UpdateDrainRepository from "../persistence/UpdateDrainRepository.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);
const isThreadLaunchError = Schema.is(ThreadLaunch.ThreadLaunchError);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly withUpdateDrain?: boolean;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly removeWorktree?: GitWorkflow.GitWorkflowService["Service"]["removeWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly getLaunchSettings?: ServerSettings.ServerSettingsService["Service"]["getSettings"];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly isGitRepository?: CheckpointStore.CheckpointStore["Service"]["isGitRepository"];
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const admissionLayer = UpdateDrainAdmission.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        UpdateDrain.layer.pipe(
          Layer.provide(UpdateDrainRepository.layer),
          Layer.provide(layerDatabase),
        ),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          pendingExecution: Effect.succeed([]),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
      ),
    ),
    Layer.orDie,
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    {
      databaseLayer: layerDatabase,
      serverSettingsLayer: layerServerSettings,
      runEffectWorker: false,
      ...(options.withUpdateDrain ? { admissionLayer } : {}),
    },
  );
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    options.removeWorktree ??
      ((_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
        Effect.void),
  );
  const deleteLocalBranch = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.mock(CheckpointStore.CheckpointStore)({
      isGitRepository: options.isGitRepository ?? (() => Effect.succeed(true)),
    }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      listTemporaryOwnedBy: () => Effect.die("unused"),
      reconcileScripts: () => Effect.die("unused reconcileScripts"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      workspaceScanDirectory: () => Effect.die("unused"),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(project.workspaceRoot),
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      currentBranch: () => Effect.succeed(null),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      listLocalBranchNames: () => Effect.succeed([]),
      removeWorktree,
      deleteLocalBranch,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        layerOrchestrator,
        IdAllocator.layer,
        options.getLaunchSettings === undefined
          ? Layer.empty
          : Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: options.getLaunchSettings,
            }),
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              hasCustomTitle: false,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              pinnedAt: null,
              archivedAt: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        layerExternalServices,
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerRegistry,
      layerOrchestrator,
      layerThreadManagement,
      layerTitleRegeneration,
      layerProjectedProjects,
      layerOutbox,
      layerReceipts,
      ThreadCommandExecutor.layer,
      layerDatabase,
      layerExternalServices,
    ),
    admissionLayer,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

// These recovery fixtures retain the separate claim/message boundary of an interrupted launch.
function useSeparateInitialMessage(threads: ThreadManagement.ThreadManagementService["Service"]) {
  const dispatchLaunch = threads.dispatchLaunch;
  return vi.spyOn(threads, "dispatchLaunch").mockImplementation((input) => {
    if (input.claim.type !== "thread.create") return dispatchLaunch(input);
    const { initialMessage: _initialMessage, ...claim } = input.claim;
    return dispatchLaunch({ ...input, claim });
  });
}

it.effect.each([false, true])(
  "rejects an archived launch sender before claiming a target (reuse: %s)",
  (reuseExistingThread) => {
    const harness = makeHarness({ runSetup: () => Effect.never });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const senderThreadId = ThreadId.make("thread:launch-sender");
      yield* launches.launch(launchInput({ command: "create-sender", thread: senderThreadId }));
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-sender"),
        threadId: senderThreadId,
      });
      const original = reuseExistingThread
        ? (yield* launches.launch(
            launchInput({ command: "create-target", thread: "thread:launch-target" }),
          )).projection
        : null;
      const input = {
        ...launchInput({ command: "launch-from-sender", thread: "thread:launch-target" }),
        reuseExistingThread,
        initialMessage: {
          messageId: MessageId.make("message:launch-from-sender"),
          text: "Start the delegated work",
          attachments: [],
          senderThreadId,
        },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const failed = yield* launches.launch(input).pipe(Effect.flip);
      assert.ok(isThreadLaunchError(failed));
      assert.equal(failed.operation, "dispatch-message");
      assert.ok(isDispatchError(failed.cause));
      assert.include(String(failed.cause.cause), "not active");
      if (original === null) {
        assert.isNull(yield* threads.getThreadShell(input.threadId));
      } else {
        assert.deepEqual(yield* threads.getThreadProjection(input.threadId), original);
      }
      for (const commandId of [
        input.commandId,
        CommandId.make(`${input.commandId}:initial-message`),
      ]) {
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        assert.isEmpty(yield* outbox.listByCommandId(commandId));
      }
      yield* threads.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive-sender"),
        threadId: senderThreadId,
      });
      const retried = yield* launches.launch(input);
      assert.lengthOf(retried.projection.messages, 1);
      assert.equal(retried.projection.messages[0]?.senderThreadId, senderThreadId);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each(["archive", "delete"] as const)(
  "rejects a reused launch target that changes after preflight (%s)",
  (change) => {
    const harness = makeHarness({ runSetup: () => Effect.never });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = {
        ...launchInput({
          command: "launch-reused-target-race",
          thread: "thread:reused-target-race",
          message: "Start work",
        }),
        reuseExistingThread: true,
      };
      yield* launches.launch(
        launchInput({ command: "create-reused-target-race", thread: input.threadId }),
      );
      const preflightDone = yield* Deferred.make<void>();
      const allowDispatch = yield* Deferred.make<void>();
      const dispatchLaunch = threads.dispatchLaunch;
      const dispatchSpy = vi
        .spyOn(threads, "dispatchLaunch")
        .mockImplementation((command) =>
          Deferred.succeed(preflightDone, undefined).pipe(
            Effect.andThen(Deferred.await(allowDispatch)),
            Effect.andThen(dispatchLaunch(command)),
          ),
        );
      yield* Effect.gen(function* () {
        const launchFiber = yield* launches.launch(input).pipe(Effect.forkChild());
        yield* Deferred.await(preflightDone);
        yield* threads.dispatch({
          type: change === "archive" ? "thread.archive" : "thread.delete",
          commandId: CommandId.make("change-reused-target-race"),
          threadId: input.threadId,
        });
        yield* Deferred.succeed(allowDispatch, undefined);
        const failed = yield* Fiber.join(launchFiber).pipe(Effect.flip);
        assert.ok(isThreadLaunchError(failed));
        assert.equal(failed.operation, "dispatch-message");
        assert.ok(isDispatchError(failed.cause));
        assert.include(String(failed.cause.cause), "not active");
        for (const commandId of [
          input.commandId,
          CommandId.make(`${input.commandId}:initial-message`),
        ]) {
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
          assert.isEmpty(yield* outbox.listByCommandId(commandId));
        }
        if (change === "archive") {
          yield* threads.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("unarchive-reused-target-race"),
            threadId: input.threadId,
          });
          const retried = yield* launches.launch(input);
          assert.lengthOf(retried.projection.messages, 1);
          yield* threads.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-reused-target-race"),
            threadId: input.threadId,
          });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const archiveCommandId = CommandId.make("rearchive-reused-target-race");
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: archiveCommandId,
            threadId: input.threadId,
          });
          assert.equal(
            (yield* threads.getThreadProjection(input.threadId)).thread.archivePending?.status,
            "stopping",
          );
          const pendingReplay = yield* launches.launch(input);
          assert.isTrue(pendingReplay.resumed);
          assert.lengthOf(pendingReplay.projection.messages, 1);
          // This harness disables the effect worker, so finish the archive's
          // provider teardown explicitly before checking the archived replay.
          yield* threads.executeArchive({ threadId: input.threadId, requestId: archiveCommandId });
          assert.isNotNull((yield* threads.getThreadProjection(input.threadId)).thread.archivedAt);
          const replayed = yield* launches.launch(input);
          assert.isTrue(replayed.resumed);
          assert.lengthOf(replayed.projection.messages, 1);
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(allowDispatch, undefined)),
        Effect.ensuring(Effect.sync(() => dispatchSpy.mockRestore())),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each(["target", "sender"] as const)(
  "preserves an interrupted launch's initial message retry while its %s is archived",
  (inactive) => {
    const harness = makeHarness({ runSetup: () => Effect.never });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const senderThreadId =
        inactive === "sender" ? ThreadId.make("thread:interrupted-launch-sender") : undefined;
      if (senderThreadId !== undefined) {
        yield* launches.launch(
          launchInput({
            command: "create-interrupted-launch-sender",
            thread: senderThreadId,
            workspace: { type: "existing_worktree", worktreePath: "/existing-worktree" },
          }),
        );
      }
      const { threadId: _unusedThreadId, ...baseInput } = launchInput({
        command: "launch-interrupted-after-create",
        thread: "unused",
        message: "Deliver after reopening",
      });
      const input = {
        ...baseInput,
        initialMessage: {
          ...baseInput.initialMessage!,
          ...(senderThreadId === undefined ? {} : { senderThreadId }),
        },
      };
      const created = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const dispatchSpy = useSeparateInitialMessage(threads);
      const commitSpy = vi.spyOn(eventSink, "commitCommand").mockImplementation((command) =>
        command.commandId === input.commandId
          ? commitCommand(command).pipe(
              Effect.tap(() => Deferred.succeed(created, undefined)),
              // Interrupt the synthetic gap after the claim, before any message commits.
              Effect.andThen(Effect.interruptible(Effect.never)),
            )
          : commitCommand(command),
      );
      yield* Effect.gen(function* () {
        const launchFiber = yield* launches.launch(input).pipe(Effect.forkChild());
        yield* Deferred.await(created);
        yield* Fiber.interrupt(launchFiber);
        const claimReceipt = Option.getOrThrow(yield* receipts.getByCommandId(input.commandId));
        assert.equal(claimReceipt.status, "accepted");
        const threadId = claimReceipt.threadId;
        assert.isEmpty((yield* threads.getThreadProjection(threadId)).messages);
        yield* threads.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-interrupted-launch"),
          threadId: senderThreadId ?? threadId,
        });
        const failed = yield* launches.launch(input).pipe(Effect.flip);
        assert.ok(isThreadLaunchError(failed));
        assert.equal(failed.operation, "dispatch-message");
        assert.ok(isDispatchError(failed.cause));
        assert.include(String(failed.cause.cause), "not active");
        const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(messageCommandId)));
        assert.isEmpty(yield* outbox.listByCommandId(messageCommandId));
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive-interrupted-launch"),
          threadId: senderThreadId ?? threadId,
        });
        const retried = yield* launches.launch(input);
        assert.equal(retried.threadId, threadId);
        assert.isTrue(retried.resumed);
        assert.lengthOf(retried.projection.messages, 1);
        assert.lengthOf(retried.projection.runs, 1);
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(messageCommandId)).status,
          "accepted",
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            dispatchSpy.mockRestore();
          }),
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("holds the sender through launch acceptance and replays after it archives", () => {
  const setupEntered = Deferred.makeUnsafe<void>();
  const harness = makeHarness({
    runSetup: () => Deferred.succeed(setupEntered, undefined).pipe(Effect.andThen(Effect.never)),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const senderThreadId = ThreadId.make("thread:z-launch-sender");
    yield* launches.launch(
      launchInput({
        command: "create-race-sender",
        thread: senderThreadId,
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    // Finish the sender's background workspace update before observing its locks.
    yield* Deferred.await(setupEntered);
    const input = {
      ...launchInput({ command: "launch-race", thread: "thread:a-launch-target" }),
      initialMessage: {
        messageId: MessageId.make("message:launch-race"),
        text: "Start the delegated work",
        attachments: [],
        senderThreadId,
      },
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
    };
    const created = yield* Deferred.make<void>();
    const allowMessage = yield* Deferred.make<void>();
    const archiveQueued = yield* Deferred.make<void>();
    const commitCommand = eventSink.commitCommand;
    const dispatchSpy = useSeparateInitialMessage(threads);
    const commitSpy = vi.spyOn(eventSink, "commitCommand").mockImplementation((command) =>
      command.commandId === input.commandId
        ? commitCommand(command).pipe(
            Effect.tap(() => Deferred.succeed(created, undefined)),
            Effect.tap(() => Deferred.await(allowMessage)),
          )
        : commitCommand(command),
    );
    // The planner captures lock ports during setup; observe acquisition without replacing that port.
    const archiveTracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        if (span.name === "ThreadCommandExecutor.withPersistenceLock")
          Deferred.doneUnsafe(archiveQueued, Effect.void);
        return span;
      },
    });
    yield* Effect.gen(function* () {
      const launchFiber = yield* launches
        .launch(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.raceFirst(
        Deferred.await(created),
        Fiber.join(launchFiber).pipe(
          Effect.andThen(Effect.die("Launch missed the creation barrier.")),
        ),
      );
      const archiveFiber = yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-race-sender"),
          threadId: senderThreadId,
        })
        .pipe(
          Effect.withTracer(archiveTracer),
          Effect.withTracerEnabled(true),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.raceFirst(
        Deferred.await(archiveQueued),
        Fiber.join(archiveFiber).pipe(
          Effect.andThen(Effect.die("Archive bypassed launch acceptance.")),
        ),
      );
      assert.isNull((yield* threads.getThreadProjection(senderThreadId)).thread.archivedAt);
      assert.isEmpty((yield* threads.getThreadProjection(input.threadId)).messages);
      yield* Deferred.succeed(allowMessage, undefined);
      const launched = yield* Fiber.join(launchFiber);
      yield* Fiber.join(archiveFiber);
      assert.isNotNull((yield* threads.getThreadProjection(senderThreadId)).thread.archivedAt);
      assert.lengthOf(launched.projection.messages, 1);
      assert.equal(launched.projection.messages[0]?.senderThreadId, senderThreadId);
      const replayed = yield* launches.launch(input);
      assert.isTrue(replayed.resumed);
      assert.equal(replayed.threadId, launched.threadId);
      assert.lengthOf(replayed.projection.messages, 1);
    }).pipe(
      Effect.ensuring(Deferred.succeed(allowMessage, undefined)),
      Effect.ensuring(
        Effect.sync(() => {
          commitSpy.mockRestore();
          dispatchSpy.mockRestore();
        }),
      ),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["archive", "delete", "missing", "stopping"] as const)(
  "does not allocate a Scratch folder for an inactive sender (%s)",
  (inactive) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratchRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-scratch-" });
      let folderCount = 0;
      const harness = makeHarness({
        runSetup: () => Effect.never,
        managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: scratchRoot,
          folderForThread: () =>
            Effect.gen(function* () {
              const path = `${scratchRoot}/folder-${++folderCount}`;
              yield* fs.makeDirectory(path).pipe(Effect.orDie);
              return Option.some(path);
            }),
        }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const senderThreadId = ThreadId.make("thread:scratch-sender");
        if (inactive !== "missing") {
          yield* launches.launch(
            launchInput({
              command: "create-scratch-sender",
              thread: senderThreadId,
              ...(inactive === "stopping" ? { message: "Start sender" } : {}),
              workspace: { type: "existing_worktree", worktreePath: "/existing-worktree" },
            }),
          );
          if (inactive === "stopping") {
            yield* threads.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("stop-scratch-sender"),
              threadId: senderThreadId,
            });
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("deactivate-scratch-sender"),
              threadId: senderThreadId,
            });
            assert.equal(
              (yield* threads.getThreadShell(senderThreadId))?.archivePending?.status,
              "stopping",
            );
          } else {
            yield* threads.dispatch({
              type: inactive === "archive" ? "thread.archive" : "thread.delete",
              commandId: CommandId.make("deactivate-scratch-sender"),
              threadId: senderThreadId,
            });
          }
        }
        const input = {
          ...launchInput({ command: "scratch-from-sender", thread: "thread:scratch-target" }),
          initialMessage: { text: "Start work", attachments: [], senderThreadId },
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const failed = yield* launches.launch(input).pipe(Effect.flip);
        assert.ok(isThreadLaunchError(failed));
        assert.equal(failed.operation, "dispatch-message");
        assert.isEmpty(yield* fs.readDirectory(scratchRoot));
        assert.ok(isDispatchError(failed.cause));
        assert.include(String(failed.cause.cause), "not active");
        assert.isNull(yield* threads.getThreadShell(input.threadId));
        for (const commandId of [
          input.commandId,
          CommandId.make(`${input.commandId}:initial-message`),
        ]) {
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        }
        if (inactive === "archive") {
          yield* threads.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("reopen-scratch-sender"),
            threadId: senderThreadId,
          });
          const launched = yield* launches.launch(input);
          assert.lengthOf(launched.projection.messages, 1);
          assert.deepEqual(yield* fs.readDirectory(scratchRoot), ["folder-1"]);
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("rearchive-scratch-sender"),
            threadId: senderThreadId,
          });
          const replayed = yield* launches.launch(input);
          assert.isTrue(replayed.resumed);
          assert.lengthOf(replayed.projection.messages, 1);
          assert.equal(
            replayed.projection.thread.worktreePath,
            launched.projection.thread.worktreePath,
          );
          assert.deepEqual(yield* fs.readDirectory(scratchRoot), ["folder-1"]);
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
