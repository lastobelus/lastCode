import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadWaitHandle,
  type ThreadWaitResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class ThreadWaitEnvironmentMismatchError extends Schema.TaggedError<ThreadWaitEnvironmentMismatchError>()(
  "ThreadWaitEnvironmentMismatchError",
  { environmentId: EnvironmentId, expectedEnvironmentId: EnvironmentId },
) {}

export class ThreadWaitThreadNotFoundError extends Schema.TaggedError<ThreadWaitThreadNotFoundError>()(
  "ThreadWaitThreadNotFoundError",
  { threadId: ThreadId },
) {}

export class ThreadWaitCorrelationNotFoundError extends Schema.TaggedError<ThreadWaitCorrelationNotFoundError>()(
  "ThreadWaitCorrelationNotFoundError",
  { threadId: ThreadId, messageId: MessageId },
) {}

export class ThreadWaitInternalError extends Schema.TaggedError<ThreadWaitInternalError>()(
  "ThreadWaitInternalError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}

export class ThreadWait extends Context.Service<
  ThreadWait,
  {
    readonly wait: (
      handle: ThreadWaitHandle,
      timeoutMs: number,
    ) => Effect.Effect<
      ThreadWaitResult,
      | ThreadWaitEnvironmentMismatchError
      | ThreadWaitThreadNotFoundError
      | ThreadWaitCorrelationNotFoundError
      | ThreadWaitInternalError
    >;
  }
>()("t3/threadTools/ThreadWait") {}

const RESPONSE_MAX_CHARS = 64_000;

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;

  const wait = Effect.fn("ThreadWait.wait")(function* (
    handle: ThreadWaitHandle,
    timeoutMs: number,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    if (environmentId !== handle.environmentId) {
      return yield* new ThreadWaitEnvironmentMismatchError({
        environmentId: handle.environmentId,
        expectedEnvironmentId: environmentId,
      });
    }
    const internal = (cause: unknown) =>
      new ThreadWaitInternalError({ threadId: handle.threadId, cause });
    // Capture the durable cursor before reading. Replay closes the gap between
    // the projection read and subscribing to live events, including queued starts.
    const afterSequence = yield* events
      .latestSequence({ threadId: handle.threadId })
      .pipe(Effect.mapError(internal));
    const initial = yield* projections
      .getThreadRecords(handle.threadId, ["runs", "messages"], {
        messageIds: [handle.messageId],
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? new ThreadWaitThreadNotFoundError({ threadId: handle.threadId })
            : internal(cause),
        ),
      );
    const message = initial.messages.find((candidate) => candidate.id === handle.messageId);
    const selectedRun =
      message?.role === "user" && message.runId !== null
        ? initial.runs.find((candidate) => candidate.id === message.runId)
        : message === undefined
          ? initial.runs.find((candidate) => candidate.userMessageId === handle.messageId)
          : undefined;
    if (selectedRun === undefined || selectedRun.threadId !== handle.threadId) {
      return yield* new ThreadWaitCorrelationNotFoundError({
        threadId: handle.threadId,
        messageId: handle.messageId,
      });
    }
    const identity = {
      environmentId,
      threadId: handle.threadId,
      messageId: handle.messageId,
      runId: selectedRun.id,
    };
    const interrupted = { kind: "interrupted", ...identity } as const;
    let awaitingFinalText = false;

    const read = Effect.fn("ThreadWait.read")(function* (): Effect.fn.Return<
      ThreadWaitResult | undefined,
      ThreadWaitInternalError
    > {
      const projection = yield* projections
        .getThreadRecords(handle.threadId, ["runs", "messages", "turnItems"], {
          runIds: [selectedRun.id],
          messageRunIds: [selectedRun.id],
          messageRoles: ["assistant"],
          turnItemRunIds: [selectedRun.id],
          turnItemTypes: ["assistant_message"],
        })
        .pipe(
          Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.void),
          Effect.mapError(internal),
        );
      if (projection === undefined || projection.thread.deletedAt !== null) return interrupted;
      const run = projection.runs.find((candidate) => candidate.id === selectedRun.id);
      awaitingFinalText = run?.status === "completed";
      if (run === undefined) return interrupted;
      if (run.status === "failed") return { kind: "error", ...identity };
      if (["cancelled", "interrupted", "rolled_back"].includes(run.status)) return interrupted;
      if (run.status !== "completed") return undefined;

      // The checkpoint completion marks the run complete after provider output
      // has drained. Select its last top-level assistant item, never another run
      // or a nested subagent's response, and do not fall back past streaming text.
      const finalItem = projection.turnItems
        .filter(
          (item) =>
            item.type === "assistant_message" &&
            item.runId === run.id &&
            item.parentItemId === null,
        )
        .sort((left, right) => right.ordinal - left.ordinal)[0];
      const finalMessage =
        finalItem?.type === "assistant_message"
          ? projection.messages.find((candidate) => candidate.id === finalItem.messageId)
          : projection.turnItems.length === 0
            ? projection.messages
                .filter((candidate) => candidate.runId === run.id && candidate.role === "assistant")
                .sort(
                  (left, right) =>
                    DateTime.toEpochMillis(right.createdAt) -
                      DateTime.toEpochMillis(left.createdAt) ||
                    DateTime.toEpochMillis(right.updatedAt) -
                      DateTime.toEpochMillis(left.updatedAt) ||
                    right.id.localeCompare(left.id),
                )[0]
            : undefined;
      if (
        finalMessage?.streaming ||
        (finalItem?.type === "assistant_message" && finalItem.streaming)
      )
        return undefined;
      const text =
        finalMessage?.text ?? (finalItem?.type === "assistant_message" ? finalItem.text : "");
      const response = text.slice(-RESPONSE_MAX_CHARS);
      return {
        kind: "completed",
        ...identity,
        response,
        responseTruncated: response.length !== text.length,
      };
    });

    const current = yield* read();
    if (current !== undefined) return current;
    const waited = yield* events.stream({ threadId: handle.threadId, afterSequence }).pipe(
      Stream.mapError(internal),
      Stream.filter(({ event }) => {
        switch (event.type) {
          case "thread.deleted":
            return true;
          case "run.updated":
            return event.payload.id === selectedRun.id;
          case "message.updated":
          case "turn-item.updated":
            return awaitingFinalText && event.payload.runId === selectedRun.id;
          default:
            return false;
        }
      }),
      Stream.mapEffect(() => read()),
      Stream.filter((state): state is ThreadWaitResult => state !== undefined),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(0, timeoutMs))),
    );
    if (Option.isSome(waited) && Option.isSome(waited.value)) return waited.value.value;
    // Completion can win the projection write while timeout wins the stream race.
    return (yield* read()) ?? { kind: "timed-out" as const, waitHandle: handle };
  });

  return ThreadWait.of({ wait });
});

export const layer = Layer.effect(ThreadWait, make);
