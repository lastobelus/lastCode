import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentHttpApi,
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  TrimmedNonEmptyString,
  type ClientOrchestrationCommand,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  ThreadId,
  ThreadWaitHandle,
  type ThreadWaitResult,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
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
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadActionResume from "../orchestration/ThreadActionResume.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { layerReadOnlyConfig as SqlitePersistenceLayerReadOnly } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  DurationFromString,
  type CliAuthLocationFlags,
  resolveThreadInspectionConfig,
} from "./config.ts";

export const THREAD_READ_DEFAULT_TURN_LIMIT = 5;
export const THREAD_READ_MAX_TURN_LIMIT = 20;
export const THREAD_LIST_MAX_RESULTS = 50;
export const THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS = 20;
export const THREAD_TRANSCRIPT_MAX_CHARS = 64_000;
export const THREAD_ACTIVITY_MAX_RESULTS = 200;
export const THREAD_WAIT_MAX_TIMEOUT_MS = 600_000;

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
  threadsTruncated: Schema.optional(Schema.Boolean),
  originalThreadCount: Schema.optional(Schema.Number),
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
export const ThreadSendAcceptedResult = Schema.Struct({
  kind: Schema.Literal("accepted"),
  ...ThreadIdentity.fields,
  messageId: Schema.String,
});
const decodeThreadCurrentResult = Schema.decodeUnknownEffect(ThreadCurrentResult);
const decodeThreadListResult = Schema.decodeUnknownEffect(ThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(ThreadReadResult);
const decodeThreadSendAcceptedResult = Schema.decodeUnknownEffect(ThreadSendAcceptedResult);
const decodeThreadSendMessage = Schema.decodeUnknownEffect(
  TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
);
const decodeThreadWaitTimeoutMs = Schema.decodeUnknownEffect(
  Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: THREAD_WAIT_MAX_TIMEOUT_MS }),
  ),
);
const decodeThreadWaitDuration = Schema.decodeUnknownEffect(DurationFromString);
const decodeThreadWaitHandleString = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadWaitHandle),
);

const isAuthoritativeWaitFailure = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return false;
  return [
    "EnvironmentRequestInvalidError",
    "EnvironmentScopeRequiredError",
    "EnvironmentResourceNotFoundError",
    "EnvironmentInternalError",
    "EnvironmentAuthInvalidError",
  ].includes(String(cause._tag));
};
export const isAuthoritativeDispatchFailure = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return false;
  return [
    "EnvironmentRequestInvalidError",
    "EnvironmentScopeRequiredError",
    "EnvironmentResourceNotFoundError",
    "EnvironmentAuthInvalidError",
    "EnvironmentInternalError",
  ].includes(String(cause._tag));
};

export class ThreadSendTargetError extends Schema.TaggedErrorClass<ThreadSendTargetError>()(
  "ThreadSendTargetError",
  {
    reason: Schema.Literals(["not-found", "ambiguous"]),
    identifier: Schema.String,
    candidates: Schema.optional(Schema.Array(Schema.String)),
    candidatesTruncated: Schema.optional(Schema.Boolean),
    originalCandidateCount: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    if (this.reason === "not-found") {
      return this.identifier.length === 0
        ? "A non-blank LastCode thread id or prefix is required."
        : `LastCode thread '${this.identifier}' was not found.`;
    }
    const candidates = this.candidates ?? [];
    const suffix = this.candidatesTruncated
      ? ` (showing ${candidates.length} of ${this.originalCandidateCount})`
      : "";
    return `LastCode thread prefix '${this.identifier}' is ambiguous: ${candidates.join(", ")}${suffix}.`;
  }
}

export class ThreadSendMessageError extends Schema.TaggedErrorClass<ThreadSendMessageError>()(
  "ThreadSendMessageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return `--message must contain text and be at most ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`;
  }
}

export class ThreadSendServerUnavailableError extends Schema.TaggedErrorClass<ThreadSendServerUnavailableError>()(
  "ThreadSendServerUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The owning LastCode server is not available; thread send has no offline fallback.";
  }
}

export class ThreadDispatchUnknownError extends Schema.TaggedErrorClass<ThreadDispatchUnknownError>()(
  "ThreadDispatchUnknownError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "LastCode could not confirm whether the tracked message dispatch was accepted.";
  }
}
const isThreadDispatchUnknownError = Schema.is(ThreadDispatchUnknownError);

export const retryAmbiguousTrackedDispatch = <R>(
  dispatch: Effect.Effect<void, ThreadCliError | ThreadDispatchUnknownError, R>,
) => dispatch.pipe(Effect.catchTag("ThreadDispatchUnknownError", () => dispatch));

export type ThreadTargetResolution =
  | { readonly kind: "resolved"; readonly thread: OrchestrationThreadShell }
  | {
      readonly kind: "ambiguous";
      readonly identifier: string;
      readonly candidates: string[];
      readonly candidatesTruncated?: boolean;
      readonly originalCandidateCount?: number;
    }
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
    const candidates = matches
      .map(({ id }) => id)
      .toSorted()
      .slice(0, THREAD_AMBIGUOUS_CANDIDATE_MAX_RESULTS);
    const candidatesTruncated = matches.length > candidates.length;
    return {
      kind: "ambiguous",
      identifier: normalized,
      candidates,
      ...(candidatesTruncated
        ? { candidatesTruncated: true, originalCandidateCount: matches.length }
        : {}),
    };
  }
  return { kind: "not-found", identifier: normalized };
}

export function validateThreadTurnLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > THREAD_READ_MAX_TURN_LIMIT) {
    throw new Error(`--turn-limit must be an integer from 1 to ${THREAD_READ_MAX_TURN_LIMIT}.`);
  }
  return value;
}

const requestIdForActivity = (activity: OrchestrationThread["activities"][number]) => {
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const requestId = (activity.payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
};

const isStaleRequestFailure = (activity: OrchestrationThread["activities"][number]) => {
  if (
    activity.kind !== "provider.approval.respond.failed" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return false;
  }
  if (typeof activity.payload !== "object" || activity.payload === null) return false;
  const detail = (activity.payload as Record<string, unknown>).detail;
  if (typeof detail !== "string") return false;
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
};

const pinnedRequestActivityIndexes = (activities: OrchestrationThread["activities"]) => {
  const openRequests = new Map<string, number>();
  for (const [index, activity] of activities.entries()) {
    const requestId = requestIdForActivity(activity);
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequests.set(requestId, index);
    } else if (
      activity.kind === "approval.resolved" ||
      activity.kind === "user-input.resolved" ||
      isStaleRequestFailure(activity)
    ) {
      openRequests.delete(requestId);
    }
  }
  return new Set(openRequests.values());
};

export function boundThreadPresentation(
  messages: OrchestrationThread["messages"],
  activities: OrchestrationThread["activities"],
) {
  const pinnedActivityIndexes = pinnedRequestActivityIndexes(activities);
  const rankedActivities = activities
    .map((activity, index) => ({ index, createdAt: activity.createdAt }))
    .toSorted(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.index - left.index,
    );
  const rankedPinnedActivities = rankedActivities.filter(({ index }) =>
    pinnedActivityIndexes.has(index),
  );
  const selectedActivityIndexes = new Set(
    [
      ...rankedPinnedActivities,
      ...rankedActivities.filter(({ index }) => !pinnedActivityIndexes.has(index)),
    ]
      .slice(0, THREAD_ACTIVITY_MAX_RESULTS)
      .map(({ index }) => index),
  );
  const selectedActivities = activities
    .map((activity, originalIndex) => ({ activity, originalIndex }))
    .filter(({ originalIndex }) => selectedActivityIndexes.has(originalIndex));
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
      pinned: false,
    })),
    ...selectedActivities.map(({ activity, originalIndex }, index) => ({
      kind: "activity" as const,
      index,
      timestamp: activity.createdAt,
      length: activity.summary.length,
      pinned: pinnedActivityIndexes.has(originalIndex),
    })),
  ].toSorted(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
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
  const boundedActivities = selectedActivities.map(({ activity }, index) => ({
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

export function threadLifecycle(
  thread: OrchestrationThreadShell,
  options: { readonly now: string },
): string {
  if (thread.hasPendingUserInput || thread.hasPendingApprovals) return "pending-input";
  if (thread.snoozedUntil !== null && thread.snoozedUntil !== undefined) {
    const wakeAt = Date.parse(thread.snoozedUntil);
    const now = Date.parse(options.now);
    if (!Number.isNaN(wakeAt) && !Number.isNaN(now) && wakeAt > now) {
      const raisedByError =
        thread.session?.status === "error" &&
        (thread.snoozedAt == null ||
          Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt));
      const raisedByCompletion =
        thread.snoozedAt != null &&
        thread.latestTurn?.state === "completed" &&
        thread.latestTurn.completedAt != null &&
        Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt);
      if (!raisedByError && !raisedByCompletion) return "snoozed";
    }
  }
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  ) {
    return "working";
  }
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

export interface ThreadSendSource {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly shell: OrchestrationShellSnapshot;
  readonly dispatch: (
    command: Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }>,
  ) => Effect.Effect<unknown, ThreadCliError | ThreadDispatchUnknownError>;
}

export const sendThreadOutput = Effect.fn("sendThreadOutput")(function* (
  source: ThreadSendSource,
  input: {
    readonly identifier: string;
    readonly message: string;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly createdAt: string;
    readonly trackRequestCorrelation?: true;
    readonly rejectWaitForThreadId?: ThreadId;
  },
) {
  const resolution = resolveThreadTarget(source.shell.threads, input.identifier);
  if (resolution.kind !== "resolved") {
    return yield* new ThreadSendTargetError({
      reason: resolution.kind,
      identifier: resolution.identifier,
      ...(resolution.kind === "ambiguous"
        ? {
            candidates: resolution.candidates,
            ...(resolution.candidatesTruncated ? { candidatesTruncated: true } : {}),
            ...(resolution.originalCandidateCount !== undefined
              ? { originalCandidateCount: resolution.originalCandidateCount }
              : {}),
          }
        : {}),
    });
  }
  if (
    input.rejectWaitForThreadId !== undefined &&
    resolution.thread.id === input.rejectWaitForThreadId
  ) {
    return yield* new ThreadCliError({
      operation: "live send wait",
      cause: new Error(
        "Cannot use --wait when sending to the current thread because its queued turn cannot start until this command exits. Send without --wait instead.",
      ),
    });
  }
  const message = yield* decodeThreadSendMessage(input.message).pipe(
    Effect.mapError((cause) => new ThreadSendMessageError({ cause })),
  );
  yield* source.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: resolution.thread.id,
    message: {
      messageId: input.messageId,
      role: "user",
      text: message,
      attachments: [],
    },
    runtimeMode: resolution.thread.runtimeMode,
    interactionMode: resolution.thread.interactionMode,
    ...(input.trackRequestCorrelation === true ? { trackRequestCorrelation: true } : {}),
    createdAt: input.createdAt,
  });
  return yield* decodeThreadSendAcceptedResult({
    kind: "accepted",
    environmentId: source.descriptor.environmentId,
    threadId: resolution.thread.id,
    messageId: input.messageId,
  });
});

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

export const listThreadsOutput = Effect.fn("listThreadsOutput")(function* (
  source: ThreadReadSource,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const sortedThreads = source.shell.threads.toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
  const threadsTruncated = sortedThreads.length > THREAD_LIST_MAX_RESULTS;
  return yield* decodeThreadListResult({
    kind: "list",
    environmentId: source.descriptor.environmentId,
    ...(threadsTruncated
      ? { threadsTruncated: true, originalThreadCount: sortedThreads.length }
      : {}),
    threads: sortedThreads.slice(0, THREAD_LIST_MAX_RESULTS).map((thread) => {
      const project = projectForThread(source.shell, thread);
      return {
        environmentId: source.descriptor.environmentId,
        threadId: thread.id,
        title: thread.title,
        lifecycle: threadLifecycle(thread, { now }),
        project: projectOutput(project),
        workspace: workspaceOutput(project, thread),
        provider: providerOutput(thread),
        updatedAt: thread.updatedAt,
      };
    }),
  });
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
  const now = DateTime.formatIso(yield* DateTime.now);
  const detail = yield* source.getThread(resolution.thread.id, turnLimit);
  const project = projectForThread(source.shell, resolution.thread);
  const presentation = boundThreadPresentation(detail.thread.messages, detail.thread.activities);
  return yield* decodeThreadReadResult({
    kind: "read",
    environmentId: source.descriptor.environmentId,
    threadId: resolution.thread.id,
    title: resolution.thread.title,
    lifecycle: threadLifecycle(resolution.thread, { now }),
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

export const ThreadCliOfflineRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadActionResume.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerReadOnly),
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

export const withSendSession = <A, E, R>(
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    auth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      label: "lastcode thread cli",
    }),
    ({ token }) => run(token),
    ({ sessionId }) => auth.revokeSession(sessionId).pipe(Effect.ignore({ log: true })),
  );

const tryRunLiveThreadRead = Effect.fn("tryRunLiveThreadRead")(function* (
  config: ServerConfig.ServerConfig["Service"],
  minimumLogLevel: ServerConfig.ServerConfig["Service"]["logLevel"],
  run: (source: ThreadReadSource) => Effect.Effect<unknown, ThreadCliError>,
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return Option.none<unknown>();
  const client = yield* makeLiveClient(runtimeState.value.origin);
  const descriptorResult = yield* Effect.result(
    client.metadata.descriptor().pipe(Effect.timeout(THREAD_CLI_LIVE_TIMEOUT)),
  );
  if (descriptorResult._tag === "Failure") return Option.none<unknown>();
  const attempted = yield* Effect.result(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* withReadSession(auth, (token) =>
        Effect.gen(function* () {
          const headers = { authorization: `Bearer ${token}` };
          const sourceResult = yield* Effect.result(
            client.orchestration
              .shellSnapshot({ headers })
              .pipe(Effect.timeout(THREAD_CLI_LIVE_TIMEOUT)),
          );
          if (sourceResult._tag === "Failure") {
            return { kind: "unavailable" as const };
          }
          const output = yield* Effect.result(
            run({
              descriptor: descriptorResult.success,
              home: config.baseDir,
              shell: sourceResult.success,
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
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    ),
  );
  if (attempted._tag === "Success" && attempted.success.kind === "ran") {
    if (attempted.success.output._tag === "Failure") return yield* attempted.success.output.failure;
    return Option.some(attempted.success.output.success);
  }
  return Option.none<unknown>();
});

const runThreadRead = Effect.fn("runThreadRead")(function* (
  flags: CliAuthLocationFlags,
  run: (source: ThreadReadSource) => Effect.Effect<unknown, ThreadCliError>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveThreadInspectionConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;
  return yield* Effect.gen(function* () {
    const live = yield* tryRunLiveThreadRead(config, minimumLogLevel, run).pipe(
      Effect.provide(FetchHttpClient.layer),
    );
    if (Option.isSome(live)) {
      return yield* Console.log(yield* encodeJson(live.value));
    }

    const offlineLayer = ThreadCliOfflineRuntimeLive.pipe(
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
  });
});

const runThreadSend = Effect.fn("runThreadSend")(function* (
  flags: CliAuthLocationFlags,
  identifier: string,
  message: string,
  waitForCompletion: boolean,
  timeoutMs: number,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveThreadInspectionConfig(flags, logLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return yield* new ThreadSendServerUnavailableError({
      cause: new Error("The active home has no recorded server runtime."),
    });
  }
  const client = yield* makeLiveClient(runtimeState.value.origin);
  const descriptor = yield* client.metadata.descriptor().pipe(
    Effect.timeout(THREAD_CLI_LIVE_TIMEOUT),
    Effect.mapError((cause) => new ThreadSendServerUnavailableError({ cause })),
  );
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    let waitHandle: ThreadWaitHandle | undefined;
    const dispatched = yield* Effect.result(
      withSendSession(auth, (token) =>
        Effect.gen(function* () {
          const headers = { authorization: `Bearer ${token}` };
          const shell = yield* client.orchestration.shellSnapshot({ headers }).pipe(
            Effect.timeout(THREAD_CLI_LIVE_TIMEOUT),
            Effect.mapError(
              (cause) => new ThreadCliError({ operation: "live send target lookup", cause }),
            ),
          );
          const crypto = yield* Crypto.Crypto;
          const commandId = CommandId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) => new ThreadCliError({ operation: "send command id generation", cause }),
              ),
            ),
          );
          const messageId = MessageId.make(
            yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) => new ThreadCliError({ operation: "send message id generation", cause }),
              ),
            ),
          );
          const resolution = resolveThreadTarget(shell.threads, identifier);
          if (resolution.kind === "resolved") {
            waitHandle = {
              kind: "wait-handle",
              environmentId: descriptor.environmentId,
              threadId: resolution.thread.id,
              messageId,
            };
          }
          return yield* sendThreadOutput(
            {
              descriptor,
              shell,
              dispatch: (command) => {
                const dispatch = client.orchestration
                  .dispatch({
                    headers,
                    payload: command,
                  } as Parameters<typeof client.orchestration.dispatch>[0])
                  .pipe(
                    Effect.timeout(THREAD_CLI_LIVE_TIMEOUT),
                    Effect.asVoid,
                    Effect.mapError((cause) =>
                      waitForCompletion && !isAuthoritativeDispatchFailure(cause)
                        ? new ThreadDispatchUnknownError({ cause })
                        : new ThreadCliError({ operation: "live send dispatch", cause }),
                    ),
                  );
                return waitForCompletion ? retryAmbiguousTrackedDispatch(dispatch) : dispatch;
              },
            },
            {
              identifier,
              message,
              commandId,
              messageId,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              ...(waitForCompletion ? { trackRequestCorrelation: true as const } : {}),
              ...(waitForCompletion && process.env.T3CODE_THREAD_ID?.trim()
                ? { rejectWaitForThreadId: ThreadId.make(process.env.T3CODE_THREAD_ID.trim()) }
                : {}),
            },
          );
        }),
      ),
    );
    if (dispatched._tag === "Failure") {
      const recoveryHandle = waitHandle;
      if (
        waitForCompletion &&
        recoveryHandle !== undefined &&
        isThreadDispatchUnknownError(dispatched.failure)
      ) {
        yield* Console.error(`LASTCODE_WAIT_HANDLE=${yield* encodeJson(recoveryHandle)}`);
        return yield* Console.log(
          yield* encodeJson({ kind: "dispatch-unknown", waitHandle: recoveryHandle }),
        );
      }
      return yield* dispatched.failure;
    }
    const acceptedWaitHandle = waitHandle;
    if (!waitForCompletion || acceptedWaitHandle === undefined) {
      return yield* Console.log(yield* encodeJson(dispatched.success));
    }
    yield* Console.error(`LASTCODE_WAIT_HANDLE=${yield* encodeJson(acceptedWaitHandle)}`);
    const waitResult = yield* withReadSession(auth, (token) =>
      Effect.result(
        client.orchestration
          .waitThread({
            headers: { authorization: `Bearer ${token}` },
            payload: { waitHandle: acceptedWaitHandle, timeoutMs },
          })
          .pipe(Effect.timeout(`${timeoutMs + 5_000} millis`)),
      ),
    );
    if (waitResult._tag === "Failure" && isAuthoritativeWaitFailure(waitResult.failure)) {
      return yield* new ThreadCliError({ operation: "live wait", cause: waitResult.failure });
    }
    return yield* Console.log(
      yield* encodeJson(
        waitResult._tag === "Success"
          ? waitResult.success
          : { kind: "transport-unknown", waitHandle: acceptedWaitHandle },
      ),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const runThreadWait = Effect.fn("runThreadWait")(function* (
  flags: CliAuthLocationFlags,
  rawHandle: string,
  timeoutMs: number,
) {
  const waitHandle = yield* decodeThreadWaitHandleString(rawHandle).pipe(
    Effect.mapError((cause) => new ThreadCliError({ operation: "wait handle decoding", cause })),
  );
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveThreadInspectionConfig(flags, logLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return yield* new ThreadSendServerUnavailableError({
      cause: new Error("The active home has no recorded server runtime."),
    });
  }
  const client = yield* makeLiveClient(runtimeState.value.origin);
  const descriptor = yield* client.metadata.descriptor().pipe(
    Effect.timeout(THREAD_CLI_LIVE_TIMEOUT),
    Effect.mapError((cause) => new ThreadSendServerUnavailableError({ cause })),
  );
  if (descriptor.environmentId !== waitHandle.environmentId) {
    return yield* new ThreadCliError({
      operation: "wait environment validation",
      cause: new Error(
        `Wait handle belongs to '${waitHandle.environmentId}', not '${descriptor.environmentId}'.`,
      ),
    });
  }
  const currentThreadId = process.env.T3CODE_THREAD_ID?.trim();
  const waitingOnCurrentThread = currentThreadId === waitHandle.threadId;
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* withReadSession(auth, (token) =>
      Effect.result(
        client.orchestration
          .waitThread({
            headers: { authorization: `Bearer ${token}` },
            payload: { waitHandle, timeoutMs: waitingOnCurrentThread ? 1 : timeoutMs },
          })
          .pipe(Effect.timeout(`${(waitingOnCurrentThread ? 1 : timeoutMs) + 5_000} millis`)),
      ),
    );
    if (result._tag === "Failure" && isAuthoritativeWaitFailure(result.failure)) {
      return yield* new ThreadCliError({ operation: "live wait", cause: result.failure });
    }
    if (
      result._tag === "Success" &&
      isPendingCurrentThreadWait(waitHandle, result.success, currentThreadId)
    ) {
      return yield* new ThreadCliError({
        operation: "live wait",
        cause: new Error(
          "Cannot wait for a pending request in the current thread because its queued turn cannot start until this command exits.",
        ),
      });
    }
    yield* Console.log(
      yield* encodeJson(
        result._tag === "Success" ? result.success : { kind: "transport-unknown", waitHandle },
      ),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

export function isPendingCurrentThreadWait(
  waitHandle: ThreadWaitHandle,
  result: ThreadWaitResult,
  currentThreadId: string | undefined,
) {
  return currentThreadId === waitHandle.threadId && result.kind === "timed-out";
}

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

const sendCommand = Command.make("send", {
  ...threadLocationFlags,
  json: jsonFlag,
  thread: Argument.string("thread").pipe(
    Argument.withDescription("Exact LastCode thread id or unambiguous id prefix."),
  ),
  message: Flag.string("message").pipe(
    Flag.withDescription("User-directed message to send to the target thread."),
  ),
  wait: Flag.boolean("wait").pipe(
    Flag.withDescription("Wait for the exact tracked turn to finish."),
    Flag.withDefault(false),
  ),
  timeout: Flag.string("timeout").pipe(
    Flag.withDescription("Maximum wait duration (for example, '10 minutes')."),
    Flag.withDefault("10 minutes"),
  ),
}).pipe(
  Command.withDescription("Send a user-directed message to one live thread."),
  Command.withHandler((flags) =>
    decodeThreadWaitDuration(flags.timeout).pipe(
      Effect.map(Duration.toMillis),
      Effect.flatMap(decodeThreadWaitTimeoutMs),
      Effect.flatMap((timeoutMs) =>
        runThreadSend(flags, flags.thread, flags.message, flags.wait, timeoutMs),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
);

const waitCommand = Command.make("wait", {
  ...threadLocationFlags,
  json: jsonFlag,
  waitHandle: Argument.string("wait-handle").pipe(
    Argument.withDescription("Compact JSON wait handle returned by send --wait."),
  ),
  timeout: Flag.string("timeout").pipe(
    Flag.withDescription("Maximum wait duration (for example, '10 minutes')."),
    Flag.withDefault("10 minutes"),
  ),
}).pipe(
  Command.withDescription("Resume waiting for one exact tracked thread request."),
  Command.withHandler((flags) =>
    decodeThreadWaitDuration(flags.timeout).pipe(
      Effect.map(Duration.toMillis),
      Effect.flatMap(decodeThreadWaitTimeoutMs),
      Effect.flatMap((timeoutMs) => runThreadWait(flags, flags.waitHandle, timeoutMs)),
      Effect.provide(FetchHttpClient.layer),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Inspect and message LastCode threads."),
  Command.withSubcommands([currentCommand, listCommand, readCommand, sendCommand, waitCommand]),
);
