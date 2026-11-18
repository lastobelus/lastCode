// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  MessageId,
  type CommandId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { referencedThreads } from "../orchestration-v2/ThreadReadAuthorization.ts";
import * as Store from "./Store.ts";
import type { ThreadReadIntakeIntent } from "./Types.ts";

export interface AdmissionInput {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly commandType: string;
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly threadReadIntent?: ThreadReadIntakeIntent;
}

/** Pure matching of accepted events. Queue promotion retains the original reference nonce. */
export function matchAcceptedInput(input: AdmissionInput, nonce: MessageId) {
  const answer = input.commandType === "runtime-request.respond";
  const edit = input.commandType === "queued-run.edit";
  const message = ["message.dispatch", "thread.create", "thread.metadata.update"].includes(
    input.commandType,
  );
  const messages = input.events.filter(
    (event): event is Extract<OrchestrationV2DomainEvent, { type: "message.updated" }> =>
      event.threadId === input.threadId && event.type === "message.updated",
  );
  const request = answer
    ? input.events.find(
        (event) =>
          event.threadId === input.threadId &&
          event.type === "runtime-request.updated" &&
          event.payload.kind === "user_input" &&
          event.payload.status === "resolved",
      )
    : undefined;
  const expectedId = answer
    ? MessageId.make(`answer-context:${input.commandId}`)
    : edit
      ? MessageId.make(`queued-edit-context:${input.commandId}`)
      : message
        ? messages.find(
            (event) =>
              event.type === "message.updated" &&
              event.payload.role === "user" &&
              (event.payload.threadReadContext === undefined ||
                event.payload.threadReadContext.authorizationId === event.payload.id),
          )?.payload.id
        : undefined;
  const acceptedMessages = messages.filter(
    (event) =>
      event.type === "message.updated" &&
      (message
        ? event.payload.id === expectedId
        : answer && request?.type === "runtime-request.updated"
          ? event.payload.id === `async-answer:${request.payload.id}`
          : false),
  );
  const generalRunIds = input.events.flatMap((event) =>
    event.threadId === input.threadId &&
    event.type === "run.created" &&
    acceptedMessages.some(
      (candidate) =>
        candidate.type === "message.updated" &&
        candidate.payload.id === event.payload.userMessageId &&
        candidate.payload.runId === event.payload.id,
    )
      ? [event.payload.id]
      : [],
  );
  let reference = false;
  const events = input.events.map((event): OrchestrationV2DomainEvent => {
    if (event.threadId !== input.threadId || expectedId === undefined) return event;
    if (
      message &&
      event.type === "message.updated" &&
      event.payload.id === expectedId &&
      event.payload.threadReadContext === undefined &&
      referencedThreads(event.payload.text, event.payload.context).length > 0
    ) {
      reference = true;
      return {
        ...event,
        payload: {
          ...event.payload,
          threadReadContext: {
            authorizationId: nonce,
            capturedAt: DateTime.toEpochMillis(event.payload.createdAt),
          },
        },
      };
    }
    if (
      (event.type === "message.updated" || event.type === "runtime-request.updated") &&
      event.payload.threadReadContext?.authorizationId === expectedId
    ) {
      reference = true;
      return {
        ...event,
        payload: {
          ...event.payload,
          threadReadContext: { ...event.payload.threadReadContext, authorizationId: nonce },
        },
      } as OrchestrationV2DomainEvent;
    }
    return event;
  });
  return {
    events,
    expectedId,
    generalRunIds,
    reference,
    referenceId: reference ? nonce : undefined,
    messageIds: acceptedMessages.map((event) => event.payload.id),
  };
}

/** Called after receipt reservation, on the writer, before appending or projecting. */
export const admitAcceptedInput = Effect.fn("threadReadAuthority.admit")(function* (
  input: AdmissionInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const matched = matchAcceptedInput(
    input,
    MessageId.make(`read-reference:${NodeCrypto.randomUUID()}`),
  );
  const intent = input.threadReadIntent;
  if (!intent || intent.threadId !== input.threadId || intent.inputId !== matched.expectedId)
    return matched.events;
  const store = yield* Store.make;
  const now = yield* Clock.currentTimeMillis;
  // A new command ID cannot take over an input already accepted by another receipt, even after eviction.
  if (input.commandType !== "queued-run.edit" && input.commandType !== "runtime-request.respond") {
    for (const messageId of matched.messageIds) {
      const used =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = ${input.threadId} AND message_id = ${messageId}
        UNION ALL SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${input.threadId} AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.userMessageId') ELSE X'' END IN (${messageId}, X'')
        UNION ALL SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = ${input.threadId} AND role = 'user'
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END IN (${messageId}, X'')
        UNION ALL SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${input.threadId}
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END IN (${messageId}, X'') LIMIT 1`;
      if (used.length > 0) return matched.events;
    }
  }
  const denial =
    intent.denialReason ??
    (intent.authority === undefined
      ? undefined
      : (yield* store.authorityCurrent(intent.authority, now))
        ? undefined
        : yield* store.admissionFailureReason(intent.authority));
  for (const runId of matched.generalRunIds) {
    const used =
      yield* sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${input.threadId} AND run_id = ${runId}`;
    if (used.length > 0) return matched.events;
    if (denial !== undefined) yield* store.recordFailure(input.threadId, "run", runId, denial, now);
    else if (
      intent.authority === undefined ||
      !(yield* store.bindGrant(input.threadId, "run", runId, intent.authority, now))
    )
      return matched.events;
  }
  if (matched.referenceId !== undefined) {
    if (denial !== undefined)
      yield* store.recordFailure(input.threadId, "reference", matched.referenceId, denial, now);
    else if (intent.authority !== undefined)
      yield* store.bindGrant(
        input.threadId,
        "reference",
        matched.referenceId,
        intent.authority,
        now,
      );
  }
  yield* store.prune(now);
  return matched.events;
});
