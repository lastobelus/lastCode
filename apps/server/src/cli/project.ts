import {
  CommandId,
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type OrchestrationReadModel,
  ProjectId,
  ProjectScript,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  ManagedProjectActionState,
  ProjectActionReconciliationError,
  prepareManagedProjectActionPendingState,
  markManagedProjectActionPendingStateApplied,
  reconcileProjectActions,
  resolveManagedProjectActionPendingState,
} from "./projectActionReconciliation.ts";

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  {
    type: "project.create" | "project.meta.update" | "project.scripts.reconcile" | "project.delete";
  }
>;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class ProjectCommandIdGenerationError extends Schema.TaggedErrorClass<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedErrorClass<ProjectLiveServerDeclaredResponseError>()(
  "ProjectLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedErrorClass<ProjectLiveServerUndeclaredStatusError>()(
  "ProjectLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class ProjectLiveServerRequestError extends Schema.TaggedErrorClass<ProjectLiveServerRequestError>()(
  "ProjectLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedErrorClass<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedErrorClass<ProjectIdentifierEmptyError>()(
  "ProjectIdentifierEmptyError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return "Project identifier cannot be empty.";
  }
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'.`;
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedErrorClass<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `An active project already exists for '${this.workspaceRoot}'.`;
  }
}

export class ProjectActionReconcileFileError extends Schema.TaggedErrorClass<ProjectActionReconcileFileError>()(
  "ProjectActionReconcileFileError",
  {
    operation: Schema.Literals([
      "read_source",
      "decode_source",
      "read_state",
      "decode_state",
      "write_state",
    ]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation.replaceAll("_", " ")} at ${this.filePath}.`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectLiveServerRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectActionReconcileFileError,
  ProjectActionReconciliationError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

export function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError {
  if (isEnvironmentHttpCommonError(cause)) {
    return new ProjectLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new ProjectLiveServerRequestError({ operation: "callLiveServer", cause });
}

const projectCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
const withProjectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT));

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* new ProjectIdentifierEmptyError({
      operation: "resolveProjectTarget",
      identifier: input.identifier,
    });
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === "Success" ? normalizedWorkspaceRootResult.success : null;

  const exactWorkspaceMatch =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot);

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* new ProjectNotFoundError({
      operation: "resolveProjectTarget",
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      ...(normalizedWorkspaceRoot === null ? {} : { normalizedWorkspaceRoot }),
      ...(normalizedWorkspaceRootResult._tag === "Failure"
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    });
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(
    withProjectCliLiveServerTimeout,
    Effect.mapError(projectCommandErrorFromLiveServerRequest),
  );

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // Project commands only read the project list, so use the lightweight
  // command read model instead of hydrating every thread body in the database.
  return yield* projectionSnapshotQuery.getCommandReadModel();
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withProjectCliSessionToken(environmentAuth, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.result(attempt);
    if (attempted._tag === "Success") {
      return Option.some(attempted.success);
    }

    yield* Effect.logDebug("Failed to connect to the persisted project CLI server.", {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    });
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);

    if (Option.isSome(liveMode)) {
      return yield* withProjectCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* new ProjectAlreadyExistsError({
            operation: "addProject",
            projectId: existingProject.id,
            workspaceRoot,
          });
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(yield* projectCommandUuid);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

const decodeT3ProjectFile = Schema.decodeUnknownEffect(T3ProjectFileFromJson);
const decodeManagedProjectActionState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedProjectActionState),
);
const encodeManagedProjectActionState = Schema.encodeSync(
  Schema.fromJsonString(ManagedProjectActionState),
);
const encodeProjectScripts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ProjectScript)));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const readManagedProjectActionState = Effect.fn("readManagedProjectActionState")(function* (
  stateFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(stateFile).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new ProjectActionReconcileFileError({
                operation: "read_state",
                filePath: stateFile,
                cause,
              }),
            ),
      onSuccess: (contents) => Effect.succeed(Option.some(contents)),
    }),
  );
  if (Option.isNone(raw)) return Option.none<ManagedProjectActionState>();
  return Option.some(
    yield* decodeManagedProjectActionState(raw.value).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectActionReconcileFileError({
            operation: "decode_state",
            filePath: stateFile,
            cause,
          }),
      ),
    ),
  );
});

const projectReconcileActionsCommand = Command.make("reconcile-actions", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to reconcile."),
  ),
  sourceFile: Flag.string("source-file").pipe(
    Flag.withDescription("Absolute path to the checked-in t3.json source."),
  ),
  stateFile: Flag.string("state-file").pipe(
    Flag.withDescription("Absolute environment-local ownership state path."),
  ),
  createIfMissing: Flag.boolean("create-if-missing").pipe(
    Flag.withDescription("Create the project before reconciling when it is not yet registered."),
    Flag.withDefault(false),
  ),
  trustedSourceIds: Flag.string("trusted-source-ids").pipe(
    Flag.withDescription("Comma-separated checked-in Action ids granted agent resume."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Reconcile managed checked-in Project Actions."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectReconcileActionsMutation")(function* ({ snapshot, dispatch, mode }) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!path.isAbsolute(flags.sourceFile) || !path.isAbsolute(flags.stateFile)) {
          return yield* new ProjectActionReconcileFileError({
            operation: "read_source",
            filePath: !path.isAbsolute(flags.sourceFile) ? flags.sourceFile : flags.stateFile,
            cause: new Error("Managed Project Action paths must be absolute."),
          });
        }

        const sourceRaw = yield* fs.readFileString(flags.sourceFile).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectActionReconcileFileError({
                operation: "read_source",
                filePath: flags.sourceFile,
                cause,
              }),
          ),
        );
        const source = yield* decodeT3ProjectFile(sourceRaw).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectActionReconcileFileError({
                operation: "decode_source",
                filePath: flags.sourceFile,
                cause,
              }),
          ),
        );
        const persistedState = yield* readManagedProjectActionState(flags.stateFile);
        const trustedSourceIds = new Set(
          (Option.getOrUndefined(flags.trustedSourceIds) ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );

        const target = yield* Effect.result(
          findActiveProjectTarget({ snapshot, identifier: flags.project }),
        );
        let projectId: ProjectId;
        let projectTitle: string;
        let projectWorkspaceRoot: string;
        let currentScripts: ReadonlyArray<ProjectScript>;
        let projectCreated = false;
        if (target._tag === "Success") {
          const project = snapshot.projects.find((entry) => entry.id === target.success.id);
          if (project === undefined) {
            return yield* new ProjectNotFoundError({
              operation: "resolveProjectTarget",
              identifier: flags.project,
              activeProjectCount: snapshot.projects.length,
            });
          }
          projectId = project.id;
          projectTitle = project.title;
          projectWorkspaceRoot = project.workspaceRoot;
          currentScripts = project.scripts;
        } else if (target.failure._tag === "ProjectNotFoundError" && flags.createIfMissing) {
          projectWorkspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.project);
          projectTitle = yield* resolveProjectTitle(projectWorkspaceRoot);
          projectId = ProjectId.make(yield* projectCommandUuid);
          currentScripts = [];
          projectCreated = true;
        } else {
          return yield* target.failure;
        }

        const previousState = Option.map(persistedState, (state) =>
          resolveManagedProjectActionPendingState({ state, currentScripts }),
        );

        const reconciled = yield* reconcileProjectActions({
          projectWorkspaceRoot,
          currentScripts,
          declarations: source.scripts ?? [],
          ...(Option.isSome(previousState) ? { previousState: previousState.value } : {}),
          trustedSourceIds,
        });
        const scriptsChanged =
          encodeProjectScripts(currentScripts) !== encodeProjectScripts(reconciled.scripts);

        if (projectCreated) {
          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make(yield* projectCommandUuid),
            projectId,
            title: projectTitle,
            workspaceRoot: projectWorkspaceRoot,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
        }

        if (scriptsChanged) {
          const pendingState = prepareManagedProjectActionPendingState({
            projectWorkspaceRoot,
            ...(Option.isSome(previousState) ? { previousState: previousState.value } : {}),
            nextScripts: reconciled.scripts,
            nextState: reconciled.state,
          });
          yield* writeFileStringAtomically({
            filePath: flags.stateFile,
            contents: `${encodeManagedProjectActionState(pendingState)}\n`,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectActionReconcileFileError({
                  operation: "write_state",
                  filePath: flags.stateFile,
                  cause,
                }),
            ),
          );
          yield* dispatch({
            type: "project.scripts.reconcile",
            commandId: CommandId.make(yield* projectCommandUuid),
            projectId,
            expectedScripts: Array.from(currentScripts),
            scripts: Array.from(reconciled.scripts),
          });
          const appliedState = markManagedProjectActionPendingStateApplied(pendingState);
          yield* writeFileStringAtomically({
            filePath: flags.stateFile,
            contents: `${encodeManagedProjectActionState(appliedState)}\n`,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectActionReconcileFileError({
                  operation: "write_state",
                  filePath: flags.stateFile,
                  cause,
                }),
            ),
          );
        }

        const encodedState = `${encodeManagedProjectActionState(reconciled.state)}\n`;
        const previousEncoded = Option.isSome(persistedState)
          ? `${encodeManagedProjectActionState(persistedState.value)}\n`
          : null;
        if (encodedState !== previousEncoded) {
          yield* writeFileStringAtomically({
            filePath: flags.stateFile,
            contents: encodedState,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectActionReconcileFileError({
                  operation: "write_state",
                  filePath: flags.stateFile,
                  cause,
                }),
            ),
          );
        }

        return encodeUnknownJson({
          mode,
          projectId,
          projectCreated,
          scriptsChanged,
          ...reconciled.report,
        });
      }),
    ),
  ),
);

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectReconcileActionsCommand,
  ]),
);
