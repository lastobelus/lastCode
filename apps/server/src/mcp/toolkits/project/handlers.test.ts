import { ThreadReadAuthorization } from "../../../orchestration-v2/ThreadReadAuthorization.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadReadBroker from "../../ThreadReadBroker.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect(
  "keeps a launched first message tied to the requesting run when its parent advances",
  () =>
    Effect.gen(function* () {
      const sourceThreadId = ThreadId.make("source-thread");
      const projectId = ProjectId.make("project");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
      const runs = new Map<
        ThreadId,
        Array<{ id: RunId; userMessageId: MessageId; status: string }>
      >();
      // When set, another client's input starts after the tool has loaded its caller.
      let advanceAfterCallerLoads = false;
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
        getThreadRecords: (threadId) =>
          Effect.gen(function* () {
            if (threadId === sourceThreadId && advanceAfterCallerLoads) {
              advanceAfterCallerLoads = false;
              yield* submit("between-client-session", sourceThreadId, "between-run");
            }
            return {
              thread: { id: threadId },
              runs: runs.get(threadId) ?? [],
              contextTransfers: [],
            } as unknown as OrchestrationV2ThreadProjection;
          }),
      });
      const broker = yield* ThreadReadBroker.ThreadReadBroker.pipe(
        Effect.provide(ThreadReadBroker.layer.pipe(Layer.provide([NodeCrypto.layer, threads]))),
      );
      const submit = (sessionId: string, threadId: ThreadId, runId: string) =>
        Effect.gen(function* () {
          const messageId = MessageId.make(`${runId}-message`);
          yield* broker.forSession(sessionId).authorize(threadId, messageId);
          for (const run of runs.get(threadId) ?? []) run.status = "completed";
          runs.set(threadId, [
            ...(runs.get(threadId) ?? []),
            { id: RunId.make(runId), userMessageId: messageId, status: "running" },
          ]);
        });
      yield* submit("requester-session", sourceThreadId, "active-run");
      const caller = {
        id: sourceThreadId,
        projectId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        activeRunId: "active-run",
        archivedAt: null,
        deletedAt: null,
      } as OrchestrationV2ThreadShell;
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const layerDependencies = Layer.mergeAll(
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(ThreadReadBroker.ThreadReadBroker, broker),
        threads,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
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
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.gen(function* () {
              // Another client advances the parent while the launch prepares.
              yield* submit("another-client-session", sourceThreadId, "later-run");
              if (input.initialMessage?.messageId !== undefined && input.threadId !== undefined) {
                const authorization = yield* ThreadReadAuthorization;
                yield* authorization.authorize(input.threadId, input.initialMessage.messageId);
              }
              return {
                threadId: input.threadId,
                projection: {
                  thread: { id: input.threadId, projectId, modelSelection },
                  runs: [],
                },
                resumed: false,
              } as unknown as ThreadLaunch.ThreadLaunchResult;
            });
          },
        }),
        Layer.mock(Project.ProjectService)({}),
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
      expect(launched[0]?.initialMessage?.senderThreadId).toBe(sourceThreadId);
      expect(launched[0]?.creatorThreadId).toBe(sourceThreadId);
      const prompted = launched[0]!;
      runs.set(prompted.threadId!, [
        {
          id: RunId.make("launched-run"),
          userMessageId: prompted.initialMessage!.messageId!,
          status: "running",
        },
      ]);
      // Only the requester's client is connected; reaching it yields a search miss.
      yield* (yield* broker.connect("requester-session")).pipe(
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
          .read(prompted.threadId!, RunId.make("launched-run"), {
            threadId: ThreadId.make("remote-thread"),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "thread_not_found" });
      const unprompted = { title: "Independent notes", creatorThreadId: "untrusted-creator" };
      yield* toolkit
        .handle("t3_thread_launch", unprompted)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      expect(launched[1]?.initialMessage).toBeUndefined();
      expect(launched[1]?.creatorThreadId).toBe(sourceThreadId);
    }).pipe(Effect.scoped),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
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
                defaultModelSelection: input.overrideModel === undefined ? modelSelection : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
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
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
        },
      ) {
        const { targeted, overrideModel, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
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
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", { title: "Fix" });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");

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
    }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
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
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
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
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);
