import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import type { TurnRequestWaitState } from "./Services/OrchestrationEngine.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

const THREAD_WAIT_RESPONSE_MAX_CHARS = 64_000;

export const readThreadWaitUntilTerminal = (
  threadId: ThreadId,
  latest: TurnRequestWaitState,
  events: Stream.Stream<OrchestrationEvent>,
  readState: Effect.Effect<TurnRequestWaitState, ProjectionRepositoryError>,
): Effect.Effect<TurnRequestWaitState, ProjectionRepositoryError> => {
  const changes = events.pipe(
    Stream.filter(
      (event) =>
        event.aggregateKind === "thread" &&
        event.aggregateId === threadId &&
        (event.type === "thread.turn-request-resolved" ||
          event.type === "thread.turn-assistant-finalized" ||
          event.type === "thread.session-set" ||
          event.type === "thread.deleted"),
    ),
  );
  const readUntilTerminal = (
    state: TurnRequestWaitState,
  ): Effect.Effect<TurnRequestWaitState, ProjectionRepositoryError> =>
    state.kind === "pending"
      ? changes.pipe(
          Stream.runHead,
          Effect.flatMap(() => readState.pipe(Effect.flatMap(readUntilTerminal))),
        )
      : Effect.succeed(state);
  return readUntilTerminal(latest);
};

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const serverEnvironment = yield* ServerEnvironment;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "waitThread",
        Effect.fn("environment.orchestration.waitThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const environmentId = yield* serverEnvironment.getEnvironmentId;
          const handle = args.payload.waitHandle;
          if (handle.environmentId !== environmentId) {
            return yield* failEnvironmentInvalidRequest("wrong_environment");
          }

          const events = yield* orchestrationEngine.subscribeDomainEvents;
          const latest = yield* orchestrationEngine
            .getTurnRequestWaitState(handle)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          const waited = yield* readThreadWaitUntilTerminal(
            handle.threadId,
            latest,
            events,
            orchestrationEngine.getTurnRequestWaitState(handle),
          ).pipe(
            Effect.timeoutOption(`${args.payload.timeoutMs} millis`),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
          if (Option.isNone(waited)) {
            return { kind: "timed-out" as const, waitHandle: handle };
          }
          const state = waited.value;
          if (state.kind === "thread-not-found") {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          if (state.kind === "correlation-not-found") {
            return yield* failEnvironmentNotFound("correlation_not_found");
          }
          if (state.kind === "terminal" && state.state === "completed") {
            const response = state.response.slice(-THREAD_WAIT_RESPONSE_MAX_CHARS);
            return {
              kind: "completed" as const,
              environmentId,
              threadId: handle.threadId,
              messageId: handle.messageId,
              turnId: state.turnId,
              response,
              responseTruncated: response.length !== state.response.length,
            };
          }
          if (state.kind !== "terminal") {
            return { kind: "timed-out" as const, waitHandle: handle };
          }
          return {
            kind: state.state,
            environmentId,
            threadId: handle.threadId,
            messageId: handle.messageId,
            ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
          };
        }),
      );
  }),
);
