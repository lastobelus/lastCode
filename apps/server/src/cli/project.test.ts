import * as UpdateDrainAdmissionTestkit from "../updateDrain/UpdateDrainAdmission.testkit.ts";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentInternalError,
  EventId,
  ProviderInstanceId,
  ThreadId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2AppThread,
  type ProjectId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainRepository from "../persistence/UpdateDrainRepository.ts";
import * as ServerOwnerLease from "../serverOwnerLease.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
} from "./project.ts";

const isProjectOperationError = Schema.is(ProjectService.ProjectOperationError);
const isUpdateDrainAdmissionError = Schema.is(UpdateDrainAdmissionError);

const layerCliRuntime = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  Layer.succeed(HostProcessPlatform, HostProcessPlatform.defaultValue()),
);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otelEnvironment: OtelEnvironment.none,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  });

const readProjects = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = RuntimeLayer.layerProjectService.pipe(
      Layer.provide(UpdateDrainAdmissionTestkit.layerOpen),
      Layer.provideMerge(ProjectEnrichmentService.layer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ProjectFaviconResolver.layer),
      Layer.provideMerge(T3ProjectFileLoader.layer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
    return yield* ProjectService.ProjectService.pipe(
      Effect.flatMap((projects) => projects.snapshot),
      Effect.provide(layer),
    );
  });

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "access_token_issuance_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it.effect("adds, renames, and removes projects through the V2 project CLI domain", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-project-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-v2-project-workspace-"),
    );

    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", "--base-dir", baseDir]);
    const added = (yield* readProjects(baseDir)).projects[0];
    assert.equal(added?.title, "Alpha");
    assert.equal(added?.workspaceRoot, workspaceRoot);

    yield* runCli(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
    assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");

    const remove = runCli(["project", "remove", added?.id ?? "", "--base-dir", baseDir]);
    if ((yield* HostProcessPlatform) !== "darwin") {
      assert.include((yield* remove.pipe(Effect.flip)).message, "exclusive server ownership");
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Beta");
    } else {
      yield* remove;
      assert.deepEqual((yield* readProjects(baseDir)).projects, []);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeProjectLookupFixture = Effect.fn("ProjectCliTest.makeProjectLookupFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-lookup-" });
  const baseDir = NodePath.join(root, "state");
  const workspaceRoot = NodePath.join(root, "workspace");
  yield* fs.makeDirectory(workspaceRoot);
  yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
  const project = (yield* readProjects(baseDir)).projects[0];
  assert.isDefined(project);
  return { baseDir, workspaceRoot, project: project! };
});

const makeThreadPersistenceLayer = Effect.fn("ProjectCliTest.makeThreadPersistenceLayer")(
  function* (baseDir: string) {
    const config = yield* makeConfig(baseDir);
    return Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStore.layer,
      EventStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    );
  },
);

const seedNativeThreads = Effect.fn("ProjectCliTest.seedNativeThreads")(function* (
  baseDir: string,
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly archived: boolean;
  }>,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  const createdAt = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  yield* Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      commandId: CommandId.make("project-cli-seed-threads"),
      events: threads.map(({ id, projectId, archived }) => {
        const payload: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id,
          projectId,
          title: id,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: archived ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        return {
          id: EventId.make(`project-cli-create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          providerInstanceId,
          occurredAt: createdAt,
          payload,
        };
      }),
    });
  }).pipe(Effect.provide(layer));
});

const readNativeThreadState = Effect.fn("ProjectCliTest.readNativeThreadState")(function* (
  baseDir: string,
  threadId: ThreadId,
) {
  const layer = yield* makeThreadPersistenceLayer(baseDir);
  return yield* Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    return {
      thread: yield* projections.getThread(threadId),
      events: yield* events.read({ threadId }).pipe(Stream.runCollect),
    };
  }).pipe(Effect.provide(layer));
});

it.layer(NodeServices.layer)("project deletion with native V2 threads", (it) => {
  it.effect.each([
    { label: "an active thread", archived: false, missing: false },
    { label: "an archived thread", archived: true, missing: false },
    {
      label: "an active thread after its workspace disappears",
      archived: false,
      missing: true,
    },
    {
      label: "an archived thread after its workspace disappears",
      archived: true,
      missing: true,
    },
  ])("rejects unforced removal of a project with $label", ({ archived, missing }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      const threadId = ThreadId.make("project-cli-preserved-thread");
      yield* seedNativeThreads(baseDir, [{ id: threadId, projectId: project.id, archived }]);
      const before = yield* readNativeThreadState(baseDir, threadId);
      if (missing) yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);

      const error = yield* runCli([
        "project",
        "remove",
        missing ? workspaceRoot : project.id,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Removing a nonempty project must require --force."),
        }),
      );

      assert.include(
        error.message,
        (yield* HostProcessPlatform) === "darwin" ? "not empty" : "exclusive server ownership",
      );
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual(yield* readNativeThreadState(baseDir, threadId), before);
      assert.equal(yield* fs.exists(workspaceRoot), !missing);
    }),
  );

  it.effect.each(["present", "missing"] as const)(
    "force-removes active and archived V2 threads with the workspace %s, preserving unrelated projects",
    (workspace) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        const otherWorkspace = `${workspaceRoot}-other`;
        yield* fs.makeDirectory(otherWorkspace);
        yield* runCli(["project", "add", otherWorkspace, "--base-dir", baseDir]);
        const otherProject = (yield* readProjects(baseDir)).projects.find(
          (entry) => entry.workspaceRoot === otherWorkspace,
        );
        assert.isDefined(otherProject);
        const activeId = ThreadId.make("project-cli-deleted-active");
        const archivedId = ThreadId.make("project-cli-deleted-archived");
        const unrelatedId = ThreadId.make("project-cli-unrelated-thread");
        yield* seedNativeThreads(baseDir, [
          { id: activeId, projectId: project.id, archived: false },
          { id: archivedId, projectId: project.id, archived: true },
          { id: unrelatedId, projectId: otherProject!.id, archived: false },
        ]);
        const unrelatedBefore = yield* readNativeThreadState(baseDir, unrelatedId);
        if (workspace === "missing") {
          yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        }

        const removal = runCli([
          "project",
          "remove",
          workspace === "missing" ? workspaceRoot : project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]);
        if ((yield* HostProcessPlatform) !== "darwin") {
          assert.include((yield* removal.pipe(Effect.flip)).message, "exclusive server ownership");
          for (const id of [activeId, archivedId])
            assert.isNull((yield* readNativeThreadState(baseDir, id)).thread.deletedAt);
          return;
        }
        yield* removal;

        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [otherProject!.id],
        );
        for (const threadId of [activeId, archivedId]) {
          const state = yield* readNativeThreadState(baseDir, threadId);
          assert.isNotNull(state.thread.deletedAt);
          assert.lengthOf(
            state.events.filter((record) => record.event.type === "thread.deleted"),
            1,
          );
        }
        assert.deepEqual(yield* readNativeThreadState(baseDir, unrelatedId), unrelatedBefore);
        assert.equal(yield* fs.exists(workspaceRoot), workspace === "present");
        assert.isTrue(yield* fs.exists(otherWorkspace));
      }),
  );
});

it.layer(NodeServices.layer)("project lookup with unavailable workspaces", (it) => {
  it.effect.each(["id", "stored path"] as const)(
    "removes an empty project by %s after its directory is gone",
    (identifier) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
        yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
        const removal = runCli([
          "project",
          "remove",
          identifier === "id" ? project.id : workspaceRoot,
          "--base-dir",
          baseDir,
        ]);
        if ((yield* HostProcessPlatform) === "darwin") {
          yield* removal;
          assert.deepEqual((yield* readProjects(baseDir)).projects, []);
        } else {
          assert.include((yield* removal.pipe(Effect.flip)).message, "exclusive server ownership");
          assert.lengthOf((yield* readProjects(baseDir)).projects, 1);
        }
        assert.isFalse(yield* fs.exists(workspaceRoot));
      }),
  );

  it.effect("renames by ID and stored path after the directory is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      for (const [identifier, title] of [
        [project.id, "Renamed by ID"],
        [workspaceRoot, "Renamed by stored path"],
      ] as const) {
        yield* runCli(["project", "rename", identifier, title, "--base-dir", baseDir]);
        assert.equal((yield* readProjects(baseDir)).projects[0]?.title, title);
      }
      assert.isFalse(yield* fs.exists(workspaceRoot));
    }),
  );

  it.effect("does not resolve another environment's project ID in an empty database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* fs.rename(workspaceRoot, `${workspaceRoot}-removed`);
      const replacementDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-project-empty-" });
      const error = yield* runCli([
        "project",
        "remove",
        project.id,
        "--force",
        "--base-dir",
        replacementDir,
      ]).pipe(Effect.flip);
      assert.include(error.message, "No active project found");
      assert.deepEqual(
        (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
        [project.id],
      );
      assert.deepEqual((yield* readProjects(replacementDir)).projects, []);
    }),
  );

  it.effect("normalizes existing paths without conflating separately registered symlinks", () =>
    Effect.gen(function* () {
      const { baseDir, workspaceRoot, project } = yield* makeProjectLookupFixture();
      yield* runCli([
        "project",
        "rename",
        `${workspaceRoot}${NodePath.sep}.`,
        "Normalized",
        "--base-dir",
        baseDir,
      ]);
      assert.equal((yield* readProjects(baseDir)).projects[0]?.title, "Normalized");
      const aliasPath = `${workspaceRoot}-alias`;
      NodeFS.symlinkSync(workspaceRoot, aliasPath, "junction");
      const unknownAlias = yield* runCli([
        "project",
        "remove",
        aliasPath,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.include(unknownAlias.message, "No active project found");
      yield* runCli(["project", "add", aliasPath, "--base-dir", baseDir]);
      const added = (yield* readProjects(baseDir)).projects;
      assert.equal(added.length, 2);
      const aliasProject = added.find((entry) => entry.workspaceRoot === aliasPath);
      assert.isDefined(aliasProject);
      assert.notEqual(aliasProject?.id, project.id);
      yield* runCli([
        "project",
        "rename",
        `${aliasPath}${NodePath.sep}.`,
        "Normalized alias",
        "--base-dir",
        baseDir,
      ]);
      const beforeRemoval = yield* readProjects(baseDir);
      assert.equal(
        beforeRemoval.projects.find((entry) => entry.id === project.id)?.title,
        "Normalized",
      );
      assert.equal(
        beforeRemoval.projects.find((entry) => entry.id === aliasProject?.id)?.title,
        "Normalized alias",
      );
      const removal = runCli([
        "project",
        "remove",
        `${aliasPath}${NodePath.sep}.`,
        "--base-dir",
        baseDir,
      ]);
      if ((yield* HostProcessPlatform) === "darwin") {
        yield* removal;
        assert.deepEqual(
          (yield* readProjects(baseDir)).projects.map((entry) => entry.id),
          [project.id],
        );
      } else {
        assert.include((yield* removal.pipe(Effect.flip)).message, "exclusive server ownership");
        assert.deepEqual(yield* readProjects(baseDir), beforeRemoval);
      }
      assert.isTrue(NodeFS.existsSync(workspaceRoot));
    }),
  );
});

it.layer(NodeServices.layer)("offline ownership and drain admission", (it) => {
  it.effect("refuses unmanaged offline deletion while preserving other offline mutations", () =>
    Effect.gen(function* () {
      const lease = vi
        .spyOn(ServerOwnerLease, "acquireServerOwnerLease")
        .mockReturnValue(Effect.succeed({ endpoint: "unmanaged", release: Effect.void }));
      yield* Effect.gen(function* () {
        const { baseDir, project } = yield* makeProjectLookupFixture();
        yield* runCli(["project", "rename", project.id, "Renamed offline", "--base-dir", baseDir]);
        const before = yield* readProjects(baseDir);
        const error = yield* runCli([
          "project",
          "remove",
          project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);
        assert.include(error.message, "exclusive server ownership");
        assert.deepEqual(yield* readProjects(baseDir), before);
      }).pipe(Effect.ensuring(Effect.sync(() => lease.mockRestore())));
    }),
  );

  it.effect("preserves an alive recorded server after failed HTTP without offline mutation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, project } = yield* makeProjectLookupFixture();
      const config = yield* makeConfig(baseDir);
      const raw = JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 1,
        origin: "http://127.0.0.1:1",
        startedAt: "2026-10-08T00:00:00.000Z",
      });
      yield* fs.writeFileString(config.serverRuntimeStatePath, raw);
      const before = yield* readProjects(baseDir);
      const error = yield* runCli([
        "project",
        "rename",
        project.id,
        "Must not commit",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      assert.instanceOf(error, ProjectLiveServerRequestError);
      assert.equal(yield* fs.readFileString(config.serverRuntimeStatePath), raw);
      assert.deepEqual(yield* readProjects(baseDir), before);
    }),
  );

  it.effect(
    "holds kernel ownership before constructing the offline database and releases after commit",
    () =>
      Effect.gen(function* () {
        if ((yield* HostProcessPlatform) !== "darwin") return;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-offline-lease-" });
        const config = yield* makeConfig(NodePath.join(root, "state"));
        const workspaceRoot = NodePath.join(root, "workspace");
        yield* fs.makeDirectory(workspaceRoot);
        yield* Effect.acquireUseRelease(
          ServerOwnerLease.acquireServerOwnerLease(config.stateDir),
          () =>
            Effect.gen(function* () {
              const error = yield* runCli([
                "project",
                "add",
                workspaceRoot,
                "--base-dir",
                config.baseDir,
              ]).pipe(Effect.flip);
              assert.instanceOf(error, ServerOwnerLease.ServerOwnerLeaseHeldError);
              assert.isFalse(yield* fs.exists(config.dbPath));
            }),
          (lease) => lease.release,
        );
        yield* runCli(["project", "add", workspaceRoot, "--base-dir", config.baseDir]);
        const project = (yield* readProjects(config.baseDir)).projects[0]!;
        yield* runCli(["project", "remove", project.id, "--base-dir", config.baseDir]);
        assert.isEmpty((yield* readProjects(config.baseDir)).projects);
        // No descriptor escapes the completed offline operation.
        yield* Effect.acquireUseRelease(
          ServerOwnerLease.acquireServerOwnerLease(config.stateDir),
          () => Effect.void,
          (lease) => lease.release,
        );
      }),
  );

  it.effect.each(["draining", "claimed"] as const)(
    "refuses offline deletion under a durable %s intent",
    (status) =>
      Effect.gen(function* () {
        const { baseDir, project } = yield* makeProjectLookupFixture();
        const config = yield* makeConfig(baseDir);
        const requestId = UpdateDrainRequestId.make("offline-cli-update");
        yield* Effect.gen(function* () {
          const drain = yield* UpdateDrain.UpdateDrain;
          yield* drain.dispatch({
            type: "update-drain.start",
            commandId: CommandId.make("offline-cli:start"),
            requestId,
            targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
            createdAt: "2026-10-08T00:00:00.000Z",
          });
          if (status === "claimed")
            yield* drain.dispatch({
              type: "update-drain.claim",
              commandId: CommandId.make("offline-cli:claim"),
              requestId,
              createdAt: "2026-10-08T00:00:00.000Z",
            });
        }).pipe(
          Effect.provide(
            UpdateDrain.layer.pipe(
              Layer.provide(UpdateDrainRepository.layer),
              Layer.provide(SqlitePersistence.layerConfig),
              Layer.provide(ServerConfig.layer(config)),
            ),
          ),
        );
        const before = yield* readProjects(baseDir);
        const error = yield* runCli([
          "project",
          "remove",
          project.id,
          "--force",
          "--base-dir",
          baseDir,
        ]).pipe(Effect.flip);
        if ((yield* HostProcessPlatform) === "darwin") {
          assert.isTrue(isProjectOperationError(error));
          if (isProjectOperationError(error))
            assert.isTrue(isUpdateDrainAdmissionError(error.cause));
        } else assert.include(error.message, "exclusive server ownership");
        assert.deepEqual(yield* readProjects(baseDir), before);
      }),
  );
});
