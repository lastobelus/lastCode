import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const THREAD_READ_DEFAULT_TURN_LIMIT = 5;
export const THREAD_READ_MAX_TURN_LIMIT = 20;
export const THREAD_LIST_MAX_RESULTS = 50;
export const THREAD_TRANSCRIPT_MAX_CHARS = 64_000;
export const THREAD_ACTIVITY_MAX_RESULTS = 200;

export class ThreadCliError extends Schema.TaggedErrorClass<ThreadCliError>()("ThreadCliError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `LastCode thread ${this.operation} failed.`;
  }
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isThreadCliError = Schema.is(ThreadCliError);

const ThreadIdentity = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
});
const ThreadProject = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
const ThreadWorkspace = Schema.Struct({
  root: Schema.String,
  branch: Schema.NullOr(Schema.String),
});
const ThreadProvider = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  instanceId: Schema.optional(Schema.String),
  status: Schema.NullOr(Schema.String),
  codexThreadId: Schema.optional(Schema.String),
});

export const ThreadCurrentResult = Schema.Struct({
  kind: Schema.Literal("current"),
  ...ThreadIdentity.fields,
  home: Schema.String,
  project: ThreadProject,
  workspace: ThreadWorkspace,
  provider: ThreadProvider,
});

export const ThreadListResult = Schema.Struct({
  kind: Schema.Literal("list"),
  environmentId: Schema.String,
  threads: Schema.Array(
    Schema.Struct({
      ...ThreadIdentity.fields,
      title: Schema.String,
      lifecycle: Schema.String,
      project: ThreadProject,
      workspace: ThreadWorkspace,
      provider: ThreadProvider,
      updatedAt: Schema.String,
    }),
  ),
});

export const ThreadReadResult = Schema.Struct({
  kind: Schema.Literal("read"),
  ...ThreadIdentity.fields,
  title: Schema.String,
  lifecycle: Schema.String,
  project: ThreadProject,
  workspace: ThreadWorkspace,
  provider: ThreadProvider,
  latestTurn: Schema.Unknown,
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      text: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      streaming: Schema.Boolean,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
  activities: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      tone: Schema.String,
      summary: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  textTruncated: Schema.Boolean,
  originalTextChars: Schema.optional(Schema.Number),
  activitiesTruncated: Schema.Boolean,
  originalActivityCount: Schema.optional(Schema.Number),
});
const decodeThreadCurrentResult = Schema.decodeUnknownEffect(ThreadCurrentResult);
const decodeThreadListResult = Schema.decodeUnknownEffect(ThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(ThreadReadResult);

export type ThreadTargetResolution =
  | { readonly kind: "resolved"; readonly thread: OrchestrationThreadShell }
  | { readonly kind: "ambiguous"; readonly identifier: string; readonly candidates: string[] }
  | { readonly kind: "not-found"; readonly identifier: string };

export function resolveThreadTarget(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  identifier: string,
): ThreadTargetResolution {
  const normalized = identifier.trim();
  if (normalized.length === 0) return { kind: "not-found", identifier: normalized };
  const exact = threads.find((thread) => thread.id === normalized);
  if (exact) return { kind: "resolved", thread: exact };
  const matches = threads.filter((thread) => thread.id.startsWith(normalized));
  if (matches.length === 1) return { kind: "resolved", thread: matches[0]! };
  if (matches.length > 1) {
    return { kind: "ambiguous", identifier: normalized, candidates: matches.map(({ id }) => id) };
  }
  return { kind: "not-found", identifier: normalized };
}

export function validateThreadTurnLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > THREAD_READ_MAX_TURN_LIMIT) {
    throw new Error(`--turn-limit must be an integer from 1 to ${THREAD_READ_MAX_TURN_LIMIT}.`);
  }
  return value;
}

export function boundThreadPresentation(
  messages: OrchestrationThread["messages"],
  activities: OrchestrationThread["activities"],
) {
  const selectedActivityIndexes = new Set(
    activities
      .map((activity, index) => ({ index, createdAt: activity.createdAt }))
      .toSorted(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || right.index - left.index,
      )
      .slice(0, THREAD_ACTIVITY_MAX_RESULTS)
      .map(({ index }) => index),
  );
  const selectedActivities = activities.filter((_, index) => selectedActivityIndexes.has(index));
  const originalTextChars =
    messages.reduce((total, message) => total + message.text.length, 0) +
    activities.reduce((total, activity) => total + activity.summary.length, 0);
  const messageChars = messages.map(() => 0);
  const activityChars = selectedActivities.map(() => 0);
  let remaining = THREAD_TRANSCRIPT_MAX_CHARS;
  const content = [
    ...messages.map((message, index) => ({
      kind: "message" as const,
      index,
      timestamp: message.updatedAt,
      length: message.text.length,
    })),
    ...selectedActivities.map((activity, index) => ({
      kind: "activity" as const,
      index,
      timestamp: activity.createdAt,
      length: activity.summary.length,
    })),
  ].toSorted(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) ||
      (left.kind === right.kind ? right.index - left.index : left.kind === "activity" ? -1 : 1),
  );
  for (const item of content) {
    const take = Math.min(item.length, remaining);
    if (item.kind === "message") messageChars[item.index] = take;
    else activityChars[item.index] = take;
    remaining -= take;
  }
  const boundedMessages = messages.map((message, index) => ({
    ...message,
    text: message.text.slice(message.text.length - messageChars[index]!),
  }));
  const boundedActivities = selectedActivities.map((activity, index) => ({
    ...activity,
    summary: activity.summary.slice(activity.summary.length - activityChars[index]!),
  }));
  const emittedTextChars = THREAD_TRANSCRIPT_MAX_CHARS - remaining;
  const activitiesTruncated = activities.length > selectedActivities.length;
  return {
    messages: boundedMessages,
    activities: boundedActivities,
    textTruncated: originalTextChars > emittedTextChars,
    ...(originalTextChars > emittedTextChars ? { originalTextChars } : {}),
    activitiesTruncated,
    ...(activitiesTruncated ? { originalActivityCount: activities.length } : {}),
  };
}

export const boundTranscriptMessages = (messages: OrchestrationThread["messages"]) =>
  boundThreadPresentation(messages, []);

export function threadLifecycle(thread: OrchestrationThreadShell): string {
  if (thread.hasPendingUserInput || thread.hasPendingApprovals) return "pending-input";
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  ) {
    return "working";
  }
  if (thread.snoozedUntil !== null && thread.snoozedUntil !== undefined) return "snoozed";
  if (thread.settledOverride === "settled" || thread.settledAt !== null) return "settled";
  return "active";
}

function projectForThread(
  snapshot: OrchestrationShellSnapshot,
  thread: OrchestrationThreadShell,
): OrchestrationProjectShell {
  const project = snapshot.projects.find(({ id }) => id === thread.projectId);
  if (!project)
    throw new Error(`Project '${thread.projectId}' for thread '${thread.id}' was not found.`);
  return project;
}

function projectOutput(project: OrchestrationProjectShell) {
  return { id: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
}

function workspaceOutput(project: OrchestrationProjectShell, thread: OrchestrationThreadShell) {
  return { root: thread.worktreePath ?? project.workspaceRoot, branch: thread.branch };
}

function providerOutput(thread: OrchestrationThreadShell) {
  const session = thread.session;
  return {
    name: session?.providerName ?? null,
    ...(session?.providerInstanceId ? { instanceId: session.providerInstanceId } : {}),
    status: session?.status ?? null,
    ...(session?.providerName === "codex" && session.providerThreadId
      ? { codexThreadId: session.providerThreadId }
      : {}),
  };
}

export interface ThreadReadSource {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly home: string;
  readonly shell: OrchestrationShellSnapshot;
  readonly getThread: (
    threadId: ThreadId,
    turnLimit: number,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot, ThreadCliError>;
}

export const currentThreadOutput = Effect.fn("currentThreadOutput")(function* (
  source: ThreadReadSource,
  context: { readonly threadId?: string; readonly home?: string } = {
    ...(process.env.T3CODE_THREAD_ID !== undefined
      ? { threadId: process.env.T3CODE_THREAD_ID }
      : {}),
    ...(process.env.T3CODE_HOME !== undefined ? { home: process.env.T3CODE_HOME } : {}),
  },
) {
  const currentId = context.threadId?.trim();
  if (!currentId) {
    return yield* new ThreadCliError({
      operation: "current context lookup",
      cause: new Error("Current LastCode thread context is unavailable."),
    });
  }
  const contextHome = context.home?.trim();
  if (contextHome && contextHome !== source.home) {
    return yield* new ThreadCliError({
      operation: "current context lookup",
      cause: new Error(`Current LastCode home '${contextHome}' does not match '${source.home}'.`),
    });
  }
  const target = source.shell.threads.find(({ id }) => id === currentId);
  if (!target) {
    return yield* new ThreadCliError({
      operation: "current context lookup",
      cause: new Error(`Current LastCode thread '${currentId}' was not found.`),
    });
  }
  const project = projectForThread(source.shell, target);
  return yield* decodeThreadCurrentResult({
    kind: "current",
    environmentId: source.descriptor.environmentId,
    threadId: target.id,
    home: source.home,
    project: projectOutput(project),
    workspace: workspaceOutput(project, target),
    provider: providerOutput(target),
  });
});

export const listThreadsOutput = (source: ThreadReadSource) =>
  decodeThreadListResult({
    kind: "list",
    environmentId: source.descriptor.environmentId,
    threads: source.shell.threads
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, THREAD_LIST_MAX_RESULTS)
      .map((thread) => {
        const project = projectForThread(source.shell, thread);
        return {
          environmentId: source.descriptor.environmentId,
          threadId: thread.id,
          title: thread.title,
          lifecycle: threadLifecycle(thread),
          project: projectOutput(project),
          workspace: workspaceOutput(project, thread),
          provider: providerOutput(thread),
          updatedAt: thread.updatedAt,
        };
      }),
  });

export const readThreadOutput = Effect.fn("readThreadOutput")(function* (
  source: ThreadReadSource,
  identifier: string,
  turnLimitInput: number,
) {
  const resolution = resolveThreadTarget(source.shell.threads, identifier);
  if (resolution.kind !== "resolved") {
    return { ...resolution, environmentId: source.descriptor.environmentId };
  }
  const turnLimit = validateThreadTurnLimit(turnLimitInput);
  const detail = yield* source.getThread(resolution.thread.id, turnLimit);
  const project = projectForThread(source.shell, resolution.thread);
  const presentation = boundThreadPresentation(detail.thread.messages, detail.thread.activities);
  return yield* decodeThreadReadResult({
    kind: "read",
    environmentId: source.descriptor.environmentId,
    threadId: resolution.thread.id,
    title: resolution.thread.title,
    lifecycle: threadLifecycle(resolution.thread),
    project: projectOutput(project),
    workspace: workspaceOutput(project, resolution.thread),
    provider: providerOutput(resolution.thread),
    latestTurn: detail.thread.latestTurn,
    messages: presentation.messages,
    activities: presentation.activities.map(({ id, kind, tone, summary, turnId, createdAt }) => ({
      id,
      kind,
      tone,
      summary,
      turnId,
      createdAt,
    })),
    textTruncated: presentation.textTruncated,
    ...(presentation.originalTextChars !== undefined
      ? { originalTextChars: presentation.originalTextChars }
      : {}),
    activitiesTruncated: presentation.activitiesTruncated,
    ...(presentation.originalActivityCount !== undefined
      ? { originalActivityCount: presentation.originalActivityCount }
      : {}),
  });
});

const ThreadCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const THREAD_CLI_LIVE_TIMEOUT = Duration.seconds(3);
const makeLiveClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const readEnvironmentId = Effect.fn("readThreadCliEnvironmentId")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const value = (yield* fileSystem.readFileString(config.environmentIdPath)).trim();
  if (value.length === 0) {
    return yield* new ThreadCliError({
      operation: "environment identity read",
      cause: new Error("The active home has no environment identity."),
    });
  }
  return EnvironmentId.make(value);
});

export const withReadSession = <A, E, R>(
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    auth.issueSession({ scopes: [AuthOrchestrationReadScope], label: "lastcode thread cli" }),
    ({ token }) => run(token),
    ({ sessionId }) => auth.revokeSession(sessionId).pipe(Effect.ignore({ log: true })),
  );

const tryRunLiveThreadRead = Effect.fn("tryRunLiveThreadRead")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig.ServerConfig["Service"],
  run: (source: ThreadReadSource) => Effect.Effect<unknown, ThreadCliError>,
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return Option.none<unknown>();
  const attempted = yield* Effect.result(
    withReadSession(auth, (token) =>
      Effect.gen(function* () {
        const client = yield* makeLiveClient(runtimeState.value.origin);
        const headers = { authorization: `Bearer ${token}` };
        const sourceResult = yield* Effect.result(
          Effect.all([
            client.metadata.descriptor(),
            client.orchestration.shellSnapshot({ headers }),
          ]).pipe(Effect.timeout(THREAD_CLI_LIVE_TIMEOUT)),
        );
        if (sourceResult._tag === "Failure") {
          return { kind: "unavailable" as const };
        }
        const [descriptor, shell] = sourceResult.success;
        const output = yield* Effect.result(
          run({
            descriptor,
            home: config.baseDir,
            shell,
            getThread: (threadId, turnLimit) =>
              client.orchestration
                .threadSnapshot({ params: { threadId }, payload: { turnLimit }, headers })
                .pipe(
                  Effect.timeout(THREAD_CLI_LIVE_TIMEOUT),
                  Effect.mapError(
                    (cause) => new ThreadCliError({ operation: "live detail read", cause }),
                  ),
                ),
          }),
        );
        return { kind: "ran" as const, output };
      }).pipe(Effect.timeout(THREAD_CLI_LIVE_TIMEOUT)),
    ),
  );
  if (attempted._tag === "Success" && attempted.success.kind === "ran") {
    if (attempted.success.output._tag === "Failure") return yield* attempted.success.output.failure;
    return Option.some(attempted.success.output.success);
  }
  yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  return Option.none<unknown>();
});

const runThreadRead = Effect.fn("runThreadRead")(function* (
  flags: CliAuthLocationFlags,
  run: (source: ThreadReadSource) => Effect.Effect<unknown, ThreadCliError>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const live = yield* tryRunLiveThreadRead(auth, config, run);
    if (Option.isSome(live)) {
      return yield* Console.log(yield* encodeJson(live.value));
    }

    const offlineLayer = ThreadCliRuntimeLive.pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );
    return yield* Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const shell = yield* query.getShellSnapshot();
      const environmentId = yield* readEnvironmentId(config);
      const source: ThreadReadSource = {
        descriptor: {
          environmentId,
          label: "offline",
          platform: { os: "unknown", arch: "other" },
          serverVersion: "offline",
          capabilities: { repositoryIdentity: true },
        },
        home: config.baseDir,
        shell,
        getThread: (threadId, turnLimit) =>
          query.getThreadDetailSnapshot(threadId, { turnLimit }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ThreadCliError({
                      operation: "offline detail read",
                      cause: new Error(`Thread '${threadId}' was not found.`),
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
            Effect.mapError((cause) =>
              isThreadCliError(cause)
                ? cause
                : new ThreadCliError({ operation: "offline detail read", cause }),
            ),
          ),
      };
      const output = yield* run(source);
      yield* Console.log(yield* encodeJson(output));
    }).pipe(Effect.provide(offlineLayer));
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print stable JSON output."),
  Flag.withDefault(false),
);

const threadLocationFlags = {
  baseDir: Flag.string("base-dir").pipe(Flag.optional),
  stateDir: Flag.string("state-dir").pipe(
    Flag.withDescription("Explicit active state directory (used by the generated wrapper)."),
    Flag.optional,
  ),
} as const;

const currentCommand = Command.make("current", {
  ...threadLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Identify the current LastCode thread."),
  Command.withHandler((flags) =>
    runThreadRead(flags, (source) =>
      currentThreadOutput(source).pipe(
        Effect.mapError((cause) =>
          isThreadCliError(cause)
            ? cause
            : new ThreadCliError({ operation: "current output encoding", cause }),
        ),
      ),
    ),
  ),
);

const listCommand = Command.make("list", {
  ...threadLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active threads in this LastCode environment."),
  Command.withHandler((flags) =>
    runThreadRead(flags, (source) =>
      listThreadsOutput(source).pipe(
        Effect.mapError(
          (cause) => new ThreadCliError({ operation: "list output encoding", cause }),
        ),
      ),
    ),
  ),
);

const readCommand = Command.make("read", {
  ...threadLocationFlags,
  json: jsonFlag,
  thread: Argument.string("thread").pipe(
    Argument.withDescription("Exact LastCode thread id or unambiguous id prefix."),
  ),
  turnLimit: Flag.integer("turn-limit").pipe(
    Flag.withDescription(`Recent user-turn window (1-${THREAD_READ_MAX_TURN_LIMIT}).`),
    Flag.withDefault(THREAD_READ_DEFAULT_TURN_LIMIT),
  ),
}).pipe(
  Command.withDescription("Read a bounded recent transcript for one thread."),
  Command.withHandler((flags) =>
    runThreadRead(flags, (source) =>
      readThreadOutput(source, flags.thread, flags.turnLimit).pipe(
        Effect.mapError((cause) =>
          isThreadCliError(cause)
            ? cause
            : new ThreadCliError({ operation: "read output encoding", cause }),
        ),
      ),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Inspect LastCode threads."),
  Command.withSubcommands([currentCommand, listCommand, readCommand]),
);
