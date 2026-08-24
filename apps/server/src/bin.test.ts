// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli, makeCli } from "./bin.ts";
import {
  ThreadCliOfflineRuntimeLive,
  ThreadSendMessageError,
  ThreadSendServerUnavailableError,
  ThreadSendTargetError,
} from "./cli/thread.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/ServerEnvironment.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const isThreadSendMessageError = Schema.is(ThreadSendMessageError);
const isThreadSendServerUnavailableError = Schema.is(ThreadSendServerUnavailableError);
const isThreadSendTargetError = Schema.is(ThreadSendTargetError);
class ProjectCliHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}

const connectCli = makeCli({ cloudEnabled: true });
const noConnectCli = makeCli({ cloudEnabled: false });
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: "0.0.0" })(args);
const runConnectCli = (args: ReadonlyArray<string>) => runCli(args, connectCli);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      "";
    const errorOutput = (yield* TestConsole.errorLines).join("\n");
    return { result, output, errorOutput };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
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

const makeProjectPersistenceLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(ServerConfig.layer(config)));

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const metadataLayer = HttpApiBuilder.group(ProjectCliHttpApi, "metadata", (handlers) =>
      Effect.succeed(
        handlers.handle("descriptor", () =>
          Effect.succeed({
            environmentId: EnvironmentId.make("env-thread-live"),
            label: "CLI integration",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: true },
          }),
        ),
      ),
    );
    const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
      Layer.provide(
        Layer.mergeAll(orchestrationHttpApiLayer, metadataLayer).pipe(
          Layer.provide(
            Layer.succeed(ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env-thread-live")),
              getDescriptor: Effect.succeed({
                environmentId: EnvironmentId.make("env-thread-live"),
                label: "CLI integration",
                platform: { os: "linux" as const, arch: "x64" as const },
                serverVersion: "test",
                capabilities: { repositoryIdentity: true },
              }),
            }),
          ),
        ),
      ),
      Layer.provide(environmentAuthenticatedAuthLayer),
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStore.layer),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(ServerConfig.layer(config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("bin cli parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    runCliWithRuntime(["--log-level", "debug", "--version"]),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    runCliWithRuntime(["--no-log-websocket-events", "--version"]),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["--log-level", "Debug"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("rejects connect commands when public configuration is missing", () =>
    Effect.gen(function* () {
      const error = yield* runCli(["connect", "status"], noConnectCli).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "connect"]);
      assert.include(error.errors[0]?.message ?? "", "missing T3 Connect public configuration");

      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, "ERROR");
      assert.include(output, "missing T3 Connect public configuration");
    }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
  );

  it.effect("exposes service lifecycle commands without T3 Connect configuration", () =>
    Effect.gen(function* () {
      const { output } = yield* captureStdout(runCli(["service", "--help"], noConnectCli));

      assert.include(output, "Manage the T3 Code background service.");
      assert.include(output, "install");
      assert.include(output, "uninstall");
      assert.include(output, "update");
      assert.include(output, "status");
    }),
  );

  it.effect("reports fresh headless connect state without requiring local configuration", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const status = JSON.parse(output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
        readonly linked: boolean;
        readonly cloudUserId: string | null;
        readonly relayUrl: string | null;
      };

      assert.equal(status.desired, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.linked, false);
      assert.equal(status.cloudUserId, null);
      assert.equal(status.relayUrl, null);
    }),
  );

  it.effect("reports actionable human-readable headless connect state", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-status-human-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir]),
      );

      assert.include(output, "T3 Connect\n  Exposure: disabled");
      assert.include(output, "  Authorization: missing");
      assert.include(output, "  Environment link: not provisioned");
      assert.include(output, "Next: Run `t3 connect link` to authorize and enable T3 Connect.");
    }),
  );

  it.effect("accepts the --headless login override without enabling access", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-login-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(secretsDir, "cloud-cli-oauth-token.bin"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off - Test fixture matches the persisted CLI token representation.
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
      );

      const login = yield* captureStdout(
        runConnectCli(["connect", "login", "--base-dir", baseDir, "--headless"]),
      );
      const status = yield* captureStdout(
        runConnectCli(["connect", "status", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
      const decoded = JSON.parse(status.output) as {
        readonly desired: boolean;
        readonly authenticated: boolean;
      };

      assert.equal(login.output, "✓ Signed in");
      assert.isFalse(decoded.desired);
      assert.isTrue(decoded.authenticated);
    }),
  );

  it.effect("disables headless connect without a running server", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-unlink-test-"),
      );
      const { output } = yield* captureStdout(
        runConnectCli(["connect", "unlink", "--base-dir", baseDir]),
      );

      assert.equal(output, "T3 Connect is disabled locally.");
    }),
  );

  it.effect("logs out of headless connect and removes the stored CLI authorization", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-cloud-logout-test-"),
      );
      const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const tokenPath = NodePath.join(secretsDir, "cloud-cli-oauth-token.bin");
      NodeFS.mkdirSync(secretsDir, { recursive: true });
      NodeFS.writeFileSync(tokenPath, "invalid persisted token");

      const { output } = yield* captureStdout(
        runConnectCli(["connect", "logout", "--base-dir", baseDir]),
      );

      assert.equal(
        output,
        "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
      );
      assert.isFalse(NodeFS.existsSync(tokenPath));
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-pairing-test-"),
      );

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string;
        readonly credential?: string;
      }>;

      assert.equal(typeof created.id, "string");
      assert.equal(typeof created.credential, "string");
      assert.equal(created.credential.length > 0, true);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal("credential" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("executes auth session subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-session-test-"),
      );

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly scopes: ReadonlyArray<string>;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly scopes: ReadonlyArray<string>;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.deepEqual(issued.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.deepEqual(listed[0]?.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      assert.equal("token" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("rejects invalid ttl values before running auth commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["auth", "pairing", "create", "--ttl", "soon"]).pipe(
        Effect.flip,
      );

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "auth", "pairing", "create"]);
      const ttlError = error.errors[0] as CliError.CliError | undefined;
      if (!ttlError || ttlError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`);
      }
      assert.equal(ttlError.option, "ttl");
      assert.equal(ttlError.value, "soon");
      assert.isTrue(ttlError.message.includes("Invalid duration"));
      assert.isTrue(ttlError.message.includes("5m, 1h, 30d, or 15 minutes"));
    }),
  );

  it.effect("adds, renames, and removes projects offline through the orchestration engine", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-offline-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-workspace-"),
      );

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Alpha",
        "--base-dir",
        baseDir,
      ]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      );
      assert.isTrue(addedProject !== undefined);
      assert.equal(addedProject?.title, "Alpha");

      yield* runCliWithRuntime(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      const afterRename = yield* readPersistedSnapshot(baseDir);
      const renamedProject = afterRename.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.equal(renamedProject?.title, "Beta");
      assert.equal(renamedProject?.deletedAt, null);

      yield* runCliWithRuntime([
        "project",
        "remove",
        addedProject?.id ?? "",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      const removedProject = afterRemove.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.isTrue((removedProject?.deletedAt ?? null) !== null);
    }),
  );

  it.effect("force removes projects that still contain threads", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-force-remove-workspace-"),
      );

      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const project = afterAdd.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
      );
      assert.isTrue(project !== undefined);

      const config = yield* makeCliTestServerConfig(baseDir);
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-cli-force-remove-thread"),
          threadId: ThreadId.make("thread-cli-force-remove"),
          projectId: project!.id,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));

      yield* runCliWithRuntime([
        "project",
        "remove",
        project!.id,
        "--force",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      assert.isTrue(
        (afterRemove.projects.find((candidate) => candidate.id === project!.id)?.deletedAt ??
          null) !== null,
      );
      assert.isTrue(
        (afterRemove.threads.find((thread) => thread.id === "thread-cli-force-remove")?.deletedAt ??
          null) !== null,
      );
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-test-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-live-workspace-"),
      );

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Live Project",
            "--base-dir",
            baseDir,
          ]);
          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const readModel = yield* projectionSnapshotQuery.getSnapshot();
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect("falls back to bounded SQLite reads without clearing the runtime record", () =>
    Effect.gen(function* () {
      const seedBaseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-offline-seed-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-offline-workspace-"),
      );
      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", seedBaseDir]);
      const snapshot = yield* readPersistedSnapshot(seedBaseDir);
      const project = snapshot.projects.find((entry) => entry.workspaceRoot === workspaceRoot)!;
      const seedConfig = yield* makeCliTestServerConfig(seedBaseDir);
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-offline-create"),
          threadId: ThreadId.make("thread-offline-bounded"),
          projectId: project.id,
          title: "Offline bounded",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        // Leave the applied schema intact but make the latest migration appear pending.
        // A setup-enabled fallback would try to run it; the inspection layer must not.
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 40`;
      }).pipe(Effect.provide(makeProjectPersistenceLayer(seedConfig)));

      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-offline-"));
      const config = yield* makeCliTestServerConfig(baseDir);
      NodeFS.mkdirSync(config.stateDir);
      const seedDatabase = new NodeSqlite.DatabaseSync(seedConfig.dbPath);
      try {
        seedDatabase.exec(`VACUUM INTO '${config.dbPath.replaceAll("'", "''")}'`);
      } finally {
        seedDatabase.close();
      }
      NodeFS.writeFileSync(config.environmentIdPath, "env-thread-offline\n");

      const unavailableRuntime = {
        version: 1 as const,
        pid: process.pid,
        port: 1,
        origin: "http://127.0.0.1:1",
        startedAt: "2026-08-21T00:00:00.000Z",
      };
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: unavailableRuntime,
      });
      const baseEntriesBefore = NodeFS.readdirSync(baseDir).toSorted();
      const stateEntriesBefore = NodeFS.readdirSync(config.stateDir).toSorted();
      for (const name of stateEntriesBefore) {
        NodeFS.chmodSync(NodePath.join(config.stateDir, name), 0o444);
      }
      NodeFS.chmodSync(config.stateDir, 0o555);
      NodeFS.chmodSync(baseDir, 0o555);
      const databaseStatBefore = NodeFS.statSync(config.dbPath);

      const { output } = yield* captureStdout(
        runCli(["thread", "read", "thread-offline", "--turn-limit", "1", "--base-dir", baseDir]),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is the integration boundary under test.
      const result = JSON.parse(output) as { readonly kind: string; readonly threadId: string };
      assert.equal(result.kind, "read");
      assert.equal(result.threadId, "thread-offline-bounded");
      const preservedRuntime = yield* readPersistedServerRuntimeState(
        config.serverRuntimeStatePath,
      );
      assert.deepStrictEqual(preservedRuntime, Option.some(unavailableRuntime));
      const databaseStatAfter = NodeFS.statSync(config.dbPath);
      assert.equal(databaseStatAfter.size, databaseStatBefore.size);
      assert.equal(databaseStatAfter.mtimeMs, databaseStatBefore.mtimeMs);
      assert.deepStrictEqual(NodeFS.readdirSync(baseDir).toSorted(), baseEntriesBefore);
      assert.deepStrictEqual(NodeFS.readdirSync(config.stateDir).toSorted(), stateEntriesBefore);
      const verificationDb = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
      try {
        assert.strictEqual(
          verificationDb
            .prepare("SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 40")
            .get(),
          undefined,
        );
      } finally {
        verificationDb.close();
      }
      NodeFS.chmodSync(baseDir, 0o755);
      NodeFS.chmodSync(config.stateDir, 0o755);
      for (const name of stateEntriesBefore) {
        NodeFS.chmodSync(NodePath.join(config.stateDir, name), 0o644);
      }
    }),
  );

  it.effect("keeps the offline thread runtime read-only", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-read-only-runtime-"),
      );
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-read-only-runtime-workspace-"),
      );
      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const config = yield* makeCliTestServerConfig(baseDir);
      yield* Effect.gen(function* () {
        const engine = yield* Effect.serviceOption(OrchestrationEngine.OrchestrationEngineService);
        const query = yield* Effect.serviceOption(ProjectionSnapshotQuery.ProjectionSnapshotQuery);
        const sql = yield* SqlClient.SqlClient;
        const writeAttempt = yield* Effect.result(
          sql`CREATE TABLE thread_cli_must_remain_read_only (id INTEGER)`,
        );

        assert.isTrue(Option.isNone(engine));
        assert.isTrue(Option.isSome(query));
        assert.strictEqual(writeAttempt._tag, "Failure");
      }).pipe(
        Effect.provide(
          ThreadCliOfflineRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }),
  );

  it.effect("uses authenticated live shell and detail reads and revokes its CLI sessions", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-live-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-live-workspace-"),
      );
      const config = yield* makeCliTestServerConfig(baseDir);
      NodeFS.mkdirSync(config.stateDir, { recursive: true });
      NodeFS.writeFileSync(config.environmentIdPath, `${EnvironmentId.make("env-thread-live")}\n`);
      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
          const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const shell = yield* query.getSnapshot();
          const project = shell.projects.find((entry) => entry.workspaceRoot === workspaceRoot)!;
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-live-create"),
            threadId: ThreadId.make("thread-live-authenticated"),
            projectId: project.id,
            title: "Live authenticated",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const before = yield* auth.listSessions();
          NodeFS.unlinkSync(config.environmentIdPath);
          const { output } = yield* captureStdout(
            runCli(["thread", "read", "thread-live", "--base-dir", baseDir]),
          );
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is the integration boundary under test.
          const result = JSON.parse(output) as { readonly kind: string; readonly threadId: string };
          assert.equal(result.kind, "read");
          assert.equal(result.threadId, "thread-live-authenticated");
          const after = yield* auth.listSessions();
          assert.equal(after.length, before.length);
        }),
      );
    }),
  );

  it.effect("sends through the authenticated live route and revokes its CLI session", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-send-live-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-send-live-workspace-"),
      );
      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
          const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const shell = yield* query.getSnapshot();
          const project = shell.projects.find((entry) => entry.workspaceRoot === workspaceRoot)!;
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const threadId = ThreadId.make("thread-send-live-authenticated");
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-send-live-create"),
            threadId,
            projectId: project.id,
            title: "Live send",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: "plan",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const beforeSessions = yield* auth.listSessions();
          const { output } = yield* captureStdout(
            runCliWithRuntime([
              "thread",
              "send",
              "thread-send-live",
              "--message",
              "  Report the current status.  ",
              "--base-dir",
              baseDir,
              "--json",
            ]),
          );
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is the integration boundary under test.
          const accepted = JSON.parse(output) as {
            readonly kind: string;
            readonly environmentId: string;
            readonly threadId: string;
            readonly messageId: string;
          };
          assert.deepStrictEqual(
            {
              kind: accepted.kind,
              environmentId: accepted.environmentId,
              threadId: accepted.threadId,
            },
            {
              kind: "accepted",
              environmentId: "env-thread-live",
              threadId,
            },
          );
          assert.isTrue(accepted.messageId.length > 0);
          const detail = yield* query.getThreadDetailSnapshot(threadId);
          assert.isTrue(Option.isSome(detail));
          if (Option.isSome(detail)) {
            const sent = detail.value.thread.messages.find(
              (message) => message.id === accepted.messageId,
            );
            assert.equal(sent?.role, "user");
            assert.equal(sent?.text, "Report the current status.");
          }
          const trackedEvents = yield* engine.subscribeDomainEvents;
          const composedTurnId = TurnId.make("turn-composed-wait");
          const spilledResponse = "s".repeat(24_001);
          const responseTail = " exact buffered tail";
          const responder = yield* trackedEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "thread.turn-start-requested" &&
                event.payload.trackRequestCorrelation === true,
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("tracked request stream ended"),
                onSome: (event) => {
                  if (event.type !== "thread.turn-start-requested") {
                    return Effect.die("unexpected tracked request event");
                  }
                  const responseAt = event.payload.createdAt;
                  return Effect.gen(function* () {
                    yield* engine.dispatch({
                      type: "thread.turn-request.resolve",
                      commandId: CommandId.make(`turn-request:${event.eventId}`),
                      threadId,
                      messageId: event.payload.messageId,
                      outcome: { kind: "started", turnId: composedTurnId },
                      createdAt: responseAt,
                    });
                    yield* engine.dispatch({
                      type: "thread.message.assistant.delta",
                      commandId: CommandId.make("cmd-composed-wait-spill"),
                      threadId,
                      messageId: MessageId.make("message-composed-wait-answer"),
                      delta: spilledResponse,
                      turnId: composedTurnId,
                      createdAt: responseAt,
                    });
                    yield* engine.dispatch({
                      type: "thread.session.set",
                      commandId: CommandId.make("cmd-composed-wait-running"),
                      threadId,
                      session: {
                        threadId,
                        status: "running",
                        providerName: "codex",
                        runtimeMode: "full-access",
                        activeTurnId: composedTurnId,
                        lastError: null,
                        updatedAt: responseAt,
                      },
                      createdAt: responseAt,
                    });
                    yield* engine.dispatch({
                      type: "thread.session.set",
                      commandId: CommandId.make("cmd-composed-wait-complete"),
                      threadId,
                      session: {
                        threadId,
                        status: "ready",
                        providerName: "codex",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: responseAt,
                      },
                      createdAt: responseAt,
                    });
                    assert.deepStrictEqual(
                      yield* engine.getTurnRequestWaitState({
                        threadId,
                        messageId: event.payload.messageId,
                      }),
                      { kind: "pending" },
                    );
                    yield* engine.dispatch({
                      type: "thread.message.assistant.delta",
                      commandId: CommandId.make("cmd-composed-wait-tail"),
                      threadId,
                      messageId: MessageId.make("message-composed-wait-answer"),
                      delta: responseTail,
                      turnId: composedTurnId,
                      createdAt: responseAt,
                    });
                    yield* engine.dispatch({
                      type: "thread.message.assistant.complete",
                      commandId: CommandId.make("cmd-composed-wait-answer-complete"),
                      threadId,
                      messageId: MessageId.make("message-composed-wait-answer"),
                      turnId: composedTurnId,
                      createdAt: responseAt,
                    });
                    yield* engine.dispatch({
                      type: "thread.turn-assistant.finalize",
                      commandId: CommandId.make("cmd-composed-wait-assistant-finalized"),
                      threadId,
                      turnId: composedTurnId,
                      createdAt: responseAt,
                    });
                    return event.payload.messageId;
                  });
                },
              }),
            ),
            Effect.forkChild,
          );
          const composed = yield* captureStdout(
            runCliWithRuntime([
              "thread",
              "send",
              threadId,
              "--message",
              "Compose and wait.",
              "--wait",
              "--base-dir",
              baseDir,
              "--json",
            ]),
          );
          const composedMessageId = yield* Fiber.join(responder);
          const recoveryLine = composed.errorOutput
            .split("\n")
            .find((line) => line.startsWith("LASTCODE_WAIT_HANDLE="));
          assert.isDefined(recoveryLine);
          // @effect-diagnostics-next-line preferSchemaOverJson:off - exact recovery framing under test.
          assert.deepStrictEqual(JSON.parse(recoveryLine!.slice("LASTCODE_WAIT_HANDLE=".length)), {
            kind: "wait-handle",
            environmentId: "env-thread-live",
            threadId,
            messageId: composedMessageId,
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off - exact CLI JSON framing under test.
          const composedResult = JSON.parse(composed.output) as {
            readonly kind: string;
            readonly environmentId: string;
            readonly threadId: string;
            readonly messageId: string;
            readonly turnId: string;
            readonly response: string;
            readonly responseTruncated: boolean;
          };
          assert.deepStrictEqual(composedResult, {
            kind: "completed",
            environmentId: "env-thread-live",
            threadId,
            messageId: composedMessageId,
            turnId: composedTurnId,
            response: `${spilledResponse}${responseTail}`,
            responseTruncated: false,
          });
          const emptyMessageId = MessageId.make("message-completed-without-assistant");
          const emptyTurnId = TurnId.make("turn-completed-without-assistant");
          const emptyAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-empty-response-start"),
            threadId,
            message: {
              messageId: emptyMessageId,
              role: "user",
              text: "Complete without an assistant message.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "plan",
            trackRequestCorrelation: true,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-request.resolve",
            commandId: CommandId.make("turn-request:empty-response"),
            threadId,
            messageId: emptyMessageId,
            outcome: { kind: "started", turnId: emptyTurnId },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-empty-response-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: emptyTurnId,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-empty-response-complete"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          assert.deepStrictEqual(
            yield* engine.getTurnRequestWaitState({ threadId, messageId: emptyMessageId }),
            { kind: "pending" },
          );
          yield* engine.dispatch({
            type: "thread.turn-assistant.finalize",
            commandId: CommandId.make("cmd-empty-response-assistant-finalized"),
            threadId,
            turnId: emptyTurnId,
            createdAt: emptyAt,
          });
          assert.deepStrictEqual(
            yield* engine.getTurnRequestWaitState({ threadId, messageId: emptyMessageId }),
            {
              kind: "terminal",
              state: "completed",
              turnId: emptyTurnId,
              response: "",
            },
          );
          const checkpointMessageId = MessageId.make("message-checkpoint-only-request");
          const checkpointTurnId = TurnId.make("turn-checkpoint-only-response");
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-checkpoint-only-start"),
            threadId,
            message: {
              messageId: checkpointMessageId,
              role: "user",
              text: "Complete with tools only.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "plan",
            trackRequestCorrelation: true,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-request.resolve",
            commandId: CommandId.make("turn-request:checkpoint-only"),
            threadId,
            messageId: checkpointMessageId,
            outcome: { kind: "started", turnId: checkpointTurnId },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-checkpoint-only-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: checkpointTurnId,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-checkpoint-only-complete"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          const checkpointAssistantMessageId = MessageId.make("message-checkpoint-real-assistant");
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-checkpoint-real-assistant-delta"),
            threadId,
            messageId: checkpointAssistantMessageId,
            delta: "actual checkpoint response",
            turnId: checkpointTurnId,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-checkpoint-real-assistant-complete"),
            threadId,
            messageId: checkpointAssistantMessageId,
            turnId: checkpointTurnId,
            createdAt: emptyAt,
          });
          const syntheticAssistantMessageId = MessageId.make(`assistant:${checkpointTurnId}`);
          yield* engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make("cmd-checkpoint-only-diff-complete"),
            threadId,
            turnId: checkpointTurnId,
            completedAt: emptyAt,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/checkpoint-only"),
            status: "ready",
            files: [],
            assistantMessageId: syntheticAssistantMessageId,
            checkpointTurnCount: 1,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-assistant.finalize",
            commandId: CommandId.make("cmd-checkpoint-only-assistant-finalized"),
            threadId,
            turnId: checkpointTurnId,
            createdAt: emptyAt,
          });
          const checkpointDetail = yield* query.getThreadDetailSnapshot(threadId);
          assert.isTrue(Option.isSome(checkpointDetail));
          if (Option.isSome(checkpointDetail)) {
            assert.isFalse(
              checkpointDetail.value.thread.messages.some(
                (message) => message.id === syntheticAssistantMessageId,
              ),
            );
          }
          assert.deepStrictEqual(
            yield* engine.getTurnRequestWaitState({
              threadId,
              messageId: checkpointMessageId,
            }),
            {
              kind: "terminal",
              state: "completed",
              turnId: checkpointTurnId,
              response: "actual checkpoint response",
            },
          );
          const bufferedMessageId = MessageId.make("message-short-buffered-request");
          const bufferedTurnId = TurnId.make("turn-short-buffered-response");
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-short-buffered-start"),
            threadId,
            message: {
              messageId: bufferedMessageId,
              role: "user",
              text: "Return a short buffered answer.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "plan",
            trackRequestCorrelation: true,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-request.resolve",
            commandId: CommandId.make("turn-request:short-buffered"),
            threadId,
            messageId: bufferedMessageId,
            outcome: { kind: "started", turnId: bufferedTurnId },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-short-buffered-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: bufferedTurnId,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-short-buffered-commentary-delta"),
            threadId,
            messageId: MessageId.make("message-short-buffered-commentary"),
            delta: "Earlier commentary segment",
            turnId: bufferedTurnId,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-short-buffered-commentary-complete"),
            threadId,
            messageId: MessageId.make("message-short-buffered-commentary"),
            turnId: bufferedTurnId,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-short-buffered-complete"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: emptyAt,
            },
            createdAt: emptyAt,
          });
          assert.deepStrictEqual(
            yield* engine.getTurnRequestWaitState({ threadId, messageId: bufferedMessageId }),
            { kind: "pending" },
          );
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-short-buffered-delta"),
            threadId,
            messageId: MessageId.make("message-short-buffered-answer"),
            delta: "short complete answer",
            turnId: bufferedTurnId,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-short-buffered-message-complete"),
            threadId,
            messageId: MessageId.make("message-short-buffered-answer"),
            turnId: bufferedTurnId,
            createdAt: emptyAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-assistant.finalize",
            commandId: CommandId.make("cmd-short-buffered-assistant-finalized"),
            threadId,
            turnId: bufferedTurnId,
            createdAt: emptyAt,
          });
          assert.deepStrictEqual(
            yield* engine.getTurnRequestWaitState({ threadId, messageId: bufferedMessageId }),
            {
              kind: "terminal",
              state: "completed",
              turnId: bufferedTurnId,
              response: "short complete answer",
            },
          );
          const trackedTurnId = TurnId.make("turn-live-wait");
          const trackedMessageId = MessageId.make("message-live-wait-request");
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-live-wait-request"),
            threadId,
            message: {
              messageId: trackedMessageId,
              role: "user",
              text: "Wait for this exact turn.",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "plan",
            trackRequestCorrelation: true,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-request.resolve",
            commandId: CommandId.make("turn-request:live-wait"),
            threadId,
            messageId: trackedMessageId,
            outcome: { kind: "started", turnId: trackedTurnId },
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-live-wait-running"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: trackedTurnId,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-live-wait-answer"),
            threadId,
            messageId: MessageId.make("message-live-wait-answer"),
            delta: "Exact tracked answer",
            turnId: trackedTurnId,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make("cmd-live-wait-answer-complete"),
            threadId,
            messageId: MessageId.make("message-live-wait-answer"),
            turnId: trackedTurnId,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-live-wait-complete"),
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.turn-assistant.finalize",
            commandId: CommandId.make("cmd-live-wait-assistant-finalized"),
            threadId,
            turnId: trackedTurnId,
            createdAt,
          });
          const recoveryHandle = {
            kind: "wait-handle" as const,
            environmentId: "env-thread-live",
            threadId,
            messageId: trackedMessageId,
          };
          const resumed = yield* captureStdout(
            runCliWithRuntime([
              "thread",
              "wait",
              // @effect-diagnostics-next-line preferSchemaOverJson:off - exact CLI JSON framing under test.
              JSON.stringify(recoveryHandle),
              "--base-dir",
              baseDir,
              "--json",
            ]),
          );
          // @effect-diagnostics-next-line preferSchemaOverJson:off - exact CLI JSON framing under test.
          const completed = JSON.parse(resumed.output) as {
            readonly kind: string;
            readonly turnId: string;
            readonly response: string;
          };
          assert.strictEqual(completed.kind, "completed");
          assert.strictEqual(completed.turnId, trackedTurnId);
          assert.strictEqual(completed.response, "Exact tracked answer");
          const missingCorrelation = yield* Effect.result(
            runCliWithRuntime([
              "thread",
              "wait",
              // @effect-diagnostics-next-line preferSchemaOverJson:off - exact CLI JSON framing under test.
              JSON.stringify({
                ...recoveryHandle,
                messageId: "message-not-projected",
              }),
              "--base-dir",
              baseDir,
            ]),
          );
          const wrongEnvironment = yield* Effect.result(
            runCliWithRuntime([
              "thread",
              "wait",
              // @effect-diagnostics-next-line preferSchemaOverJson:off - exact CLI JSON framing under test.
              JSON.stringify({
                ...recoveryHandle,
                environmentId: "another-environment",
              }),
              "--base-dir",
              baseDir,
            ]),
          );
          assert.strictEqual(missingCorrelation._tag, "Failure");
          assert.strictEqual(wrongEnvironment._tag, "Failure");
          assert.equal((yield* auth.listSessions()).length, beforeSessions.length);
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-send-live-rival"),
            threadId: ThreadId.make("thread-send-live-rival"),
            projectId: project.id,
            title: "Live send rival",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
          const ambiguous = yield* Effect.result(
            runCliWithRuntime([
              "thread",
              "send",
              "thread-send-live",
              "--message",
              "ambiguous",
              "--base-dir",
              baseDir,
            ]),
          );
          const missing = yield* Effect.result(
            runCliWithRuntime([
              "thread",
              "send",
              "missing-thread",
              "--message",
              "missing",
              "--base-dir",
              baseDir,
            ]),
          );
          const oversized = yield* Effect.result(
            runCliWithRuntime([
              "thread",
              "send",
              threadId,
              "--message",
              "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
              "--base-dir",
              baseDir,
            ]),
          );
          assert.strictEqual(ambiguous._tag, "Failure");
          assert.isTrue(ambiguous._tag === "Failure" && isThreadSendTargetError(ambiguous.failure));
          assert.strictEqual(missing._tag, "Failure");
          assert.isTrue(missing._tag === "Failure" && isThreadSendTargetError(missing.failure));
          assert.strictEqual(oversized._tag, "Failure");
          assert.isTrue(
            oversized._tag === "Failure" && isThreadSendMessageError(oversized.failure),
          );
          assert.equal((yield* auth.listSessions()).length, beforeSessions.length);
        }),
      );
    }),
  );

  it.effect("requires a live server for send without mutating offline state", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-send-offline-"));
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-thread-send-offline-workspace-"),
      );
      yield* runCliWithRuntime(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const snapshot = yield* readPersistedSnapshot(baseDir);
      const project = snapshot.projects.find((entry) => entry.workspaceRoot === workspaceRoot)!;
      const config = yield* makeCliTestServerConfig(baseDir);
      const threadId = ThreadId.make("thread-send-offline");
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-send-offline-create"),
          threadId,
          projectId: project.id,
          title: "Offline send target",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
      const databaseStatBefore = NodeFS.statSync(config.dbPath);

      const result = yield* Effect.result(
        runCliWithRuntime([
          "thread",
          "send",
          threadId,
          "--message",
          "must not persist",
          "--base-dir",
          baseDir,
        ]),
      );

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(isThreadSendServerUnavailableError(result.failure));
      }
      const databaseStatAfter = NodeFS.statSync(config.dbPath);
      assert.equal(databaseStatAfter.size, databaseStatBefore.size);
      assert.equal(databaseStatAfter.mtimeMs, databaseStatBefore.mtimeMs);
      const after = yield* readPersistedSnapshot(baseDir);
      assert.deepStrictEqual(after.threads.find((thread) => thread.id === threadId)?.messages, []);
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-cli-projects-unknown-option-workspace-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["t3", "project", "add"]);
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
