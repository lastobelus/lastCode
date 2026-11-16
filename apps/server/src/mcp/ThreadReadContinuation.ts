import {
  OrchestrationV2ConversationMessage,
  type ActionResumeOwner,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { referencedThreads } from "../orchestration-v2/ThreadReadAuthorization.ts";

type Source = { readonly threadId: ThreadId; readonly runId: RunId };
type RunKey = { readonly kind: "run"; readonly threadId: ThreadId; readonly grantId: RunId };
type ReferenceKey = {
  readonly kind: "reference";
  readonly threadId: ThreadId;
  readonly grantId: MessageId;
};

export type ThreadReadContinuationResult<Grant> =
  | {
      readonly kind: "grant";
      readonly key: RunKey | ReferenceKey;
      readonly source: Source;
      readonly grant: Grant;
    }
  | {
      /** A matching override blocks general fallback, including when its nonce has no binding. */
      readonly kind: "reference-denied";
      readonly source: Source;
      /** Absent when equally recent overrides have no provable ordering. */
      readonly key?: ReferenceKey;
    };

export interface ThreadReadContinuationInput {
  readonly threadId: ThreadId;
  readonly runId: RunId | undefined;
  /** Omit for sender/launch inheritance: only the captured run's general authority is lent. */
  readonly reference?: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
}

export interface ThreadReadContinuationOptions<Grant, E = never, R = never> {
  readonly getThreadRecords: ThreadManagementServiceShape["getThreadRecords"];
  readonly lookupRunGrant: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<Grant | undefined, E, R>;
  readonly lookupReferenceGrant: (
    threadId: ThreadId,
    nonce: MessageId,
  ) => Effect.Effect<Grant | undefined, E, R>;
  /**
   * Intake's immutable proof that this nonce belonged to the starting input. Projected
   * timestamps alone cannot distinguish an original from a later edit in the same tick.
   * Without it, all candidates use the strict capture cutoff.
   */
  readonly isOriginalInputReference?: (
    threadId: ThreadId,
    runId: RunId,
    nonce: MessageId,
  ) => Effect.Effect<boolean, E, R>;
}

const recordFields = [
  "runs",
  "contextTransfers",
  "runtimeRequests",
  "nodes",
  "providerThreads",
] as const;
type Records = ProjectionRecords<(typeof recordFields)[number]>;
type Message = OrchestrationV2ConversationMessage;
type Candidate = { readonly nonce: MessageId; readonly at: number; readonly original: boolean };
const sourceKey = (threadId: ThreadId, runId: RunId) => JSON.stringify([threadId, runId]);

const validCompletion = Schema.is(OrchestrationV2ConversationMessage.fields.delegatedCompletion);
const sameOwner = (a: ActionResumeOwner, b: ActionResumeOwner) =>
  a.sourceRunId === b.sourceRunId &&
  a.parentEnvironmentId === b.parentEnvironmentId &&
  a.parentThreadId === b.parentThreadId &&
  a.taskId === b.taskId &&
  a.delegationId === b.delegationId;

/** Only accepted provenance on this run's starting message can introduce a continuation edge. */
const continuationSource = (
  records: Records,
  run: OrchestrationV2Run,
  trigger: Message,
): RunId | null | undefined => {
  const marked =
    trigger.delegatedCompletion !== undefined ||
    run.pullRequestWatchContinuation !== undefined ||
    run.restartContinuationOfRunId !== undefined ||
    run.manualContinuationOfRunId !== undefined ||
    run.usageLimitContinuationOfRunId !== undefined ||
    run.backgroundResultContinuation !== undefined;
  if (trigger.createdBy !== "agent") return marked ? null : undefined;
  const server = trigger.creationSource === "server";
  if (!server && trigger.creationSource !== "provider") return marked ? null : undefined;
  const sources: RunId[] = [];
  if (trigger.delegatedCompletion !== undefined) {
    if (!server || !validCompletion(trigger.delegatedCompletion)) return null;
    // The persisted marker was normalized at admission. The parent's live cohort can already
    // have advanced or been acknowledged; it is not the historical delivery record.
    sources.push(trigger.delegatedCompletion.parentRunId);
  }
  const watch = run.pullRequestWatchContinuation;
  if (watch !== undefined) {
    const owner = records.runs.find((candidate) => candidate.id === watch.owner.sourceRunId);
    if (
      !server ||
      watch.messageId !== run.userMessageId ||
      !owner?.pullRequestWatchObligations?.some(
        (row) => row.generation === watch.generation && sameOwner(row.owner, watch.owner),
      )
    )
      return null;
    sources.push(owner.id);
  }
  const actions = records.runs.filter((candidate) =>
    candidate.actionObligations?.some(
      (row) =>
        row.state === "transferred" &&
        row.owner.sourceRunId === candidate.id &&
        row.continuationRunId === run.id &&
        row.messageId === run.userMessageId,
    ),
  );
  if (actions.length > 0) {
    if (!server) return null;
    sources.push(...actions.map((source) => source.id));
  }
  for (const pointer of [
    run.restartContinuationOfRunId,
    run.manualContinuationOfRunId,
    run.usageLimitContinuationOfRunId,
  ]) {
    if (pointer === undefined) continue;
    if (!server) return null;
    sources.push(pointer);
  }
  const background = run.backgroundResultContinuation;
  if (background !== undefined) {
    const origin = records.runs.find((candidate) => candidate.id === background.originRunId);
    const provider = records.providerThreads.find(
      (candidate) => candidate.id === background.providerThreadId,
    );
    if (
      origin === undefined ||
      background.taskIds.length === 0 ||
      origin.providerThreadId !== background.providerThreadId ||
      provider?.appThreadId !== run.threadId ||
      provider.ownerNodeId !== null ||
      provider.providerInstanceId !== origin.providerInstanceId
    )
      return null;
    // Owed task rosters are consumed at execution; the accepted run marker retains ownership.
    sources.push(origin.id);
  }
  const unique = new Set(sources);
  return unique.size === 1 ? [...unique][0] : unique.size === 0 ? undefined : null;
};

/**
 * Selects authority, without knowing sessions, scopes, expiry or storage. Each invocation caches
 * its own records. A reference search visits every hop before using its saved general grant.
 */
export const resolveThreadReadContinuation = Effect.fn("ThreadReadContinuation.resolve")(function* <
  Grant,
  E = never,
  R = never,
>(
  options: ThreadReadContinuationOptions<Grant, E, R>,
  input: ThreadReadContinuationInput,
): Effect.fn.Return<ThreadReadContinuationResult<Grant> | undefined, OrchestratorV2Error | E, R> {
  if (input.runId === undefined) return undefined;
  const recordsByThread = new Map<ThreadId, Records>();
  const messagesByRun = new Map<string, ReadonlyArray<Message>>();
  const visited = new Set<string>();
  const load = Effect.fnUntraced(function* (threadId: ThreadId) {
    const cached = recordsByThread.get(threadId);
    if (cached !== undefined) return cached;
    const records: Records = {
      ...(yield* options.getThreadRecords(threadId, ["runs"])),
      contextTransfers: [],
      runtimeRequests: [],
      nodes: [],
      providerThreads: [],
    };
    recordsByThread.set(threadId, records);
    return records;
  });
  const detailedThreads = new Set<ThreadId>();
  const loadDetails = Effect.fnUntraced(function* (threadId: ThreadId) {
    const base = yield* load(threadId);
    if (detailedThreads.has(threadId)) return base;
    const fields =
      input.reference === undefined
        ? (["contextTransfers", "providerThreads"] as const)
        : (["contextTransfers", "providerThreads", "runtimeRequests", "nodes"] as const);
    const records = { ...base, ...(yield* options.getThreadRecords(threadId, fields)) };
    recordsByThread.set(threadId, records);
    detailedThreads.add(threadId);
    return records;
  });
  const messagesFor = Effect.fnUntraced(function* (run: OrchestrationV2Run) {
    const key = sourceKey(run.threadId, run.id);
    const cached = messagesByRun.get(key);
    if (cached !== undefined) return cached;
    const { messages } = yield* options.getThreadRecords(run.threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["user"],
    });
    // A promoted queued message can now belong to another run. Filtering by run cannot
    // retrieve this run's immutable starting input, so query that ID independently.
    const start = messages.find((message) => message.id === run.userMessageId);
    const originals =
      start === undefined
        ? (yield* options.getThreadRecords(run.threadId, ["messages"], {
            messageIds: [run.userMessageId],
            messageRoles: ["user"],
          })).messages
        : [];
    const result = [...new Map([...messages, ...originals].map((row) => [row.id, row])).values()];
    messagesByRun.set(key, result);
    return result;
  });

  let current: Source = { threadId: input.threadId, runId: input.runId };
  let before = Number.POSITIVE_INFINITY;
  let general: ThreadReadContinuationResult<Grant> | undefined;
  while (true) {
    const identity = sourceKey(current.threadId, current.runId);
    if (visited.has(identity)) return general;
    visited.add(identity);
    let records = yield* load(current.threadId);
    const run = records.runs.find((candidate) => candidate.id === current.runId);
    if (
      run === undefined ||
      run.threadId !== current.threadId ||
      DateTime.toEpochMillis(run.requestedAt) > before
    )
      return general;
    if (general === undefined) {
      const grant = yield* options.lookupRunGrant(current.threadId, run.id);
      if (grant !== undefined) {
        general = {
          kind: "grant",
          key: { kind: "run", threadId: current.threadId, grantId: run.id },
          source: current,
          grant,
        };
        if (input.reference === undefined) return general;
      }
    }
    records = yield* loadDetails(current.threadId);
    const messages = yield* messagesFor(run);
    const trigger = messages.find(
      (message) =>
        message.id === run.userMessageId &&
        message.threadId === current.threadId &&
        message.role === "user",
    );
    if (input.reference !== undefined) {
      const reference = input.reference;
      const matches = (environmentId: EnvironmentId, threadId: ThreadId) =>
        environmentId === reference.environmentId && threadId === reference.threadId;
      const candidates: Candidate[] = [];
      for (const message of messages) {
        const context = message.threadReadContext;
        if (
          message.threadId !== current.threadId ||
          message.role !== "user" ||
          (message.runId !== run.id && message.id !== run.userMessageId) ||
          context === undefined ||
          !referencedThreads(message.text, message.context).some((record) =>
            matches(record.environmentId, record.threadId),
          )
        )
          continue;
        // An original input is known to precede an accepted continuation, even in the
        // same clock tick. An edit/answer at the boundary has no such ordering proof.
        const original =
          message.id === run.userMessageId &&
          context.capturedAt <= DateTime.toEpochMillis(message.createdAt) &&
          context.capturedAt <= DateTime.toEpochMillis(run.requestedAt) &&
          options.isOriginalInputReference !== undefined &&
          (yield* options.isOriginalInputReference(
            current.threadId,
            run.id,
            context.authorizationId,
          ));
        if (context.capturedAt < before || original) {
          candidates.push({ nonce: context.authorizationId, at: context.capturedAt, original });
        }
      }
      const nodeIds = new Set(
        records.nodes
          .filter((node) => node.threadId === current.threadId && node.runId === run.id)
          .map((node) => node.id),
      );
      for (const request of records.runtimeRequests) {
        if (
          request.kind === "user_input" &&
          request.status === "resolved" &&
          request.resolvedAt !== null &&
          (nodeIds.has(request.nodeId) ||
            (request.responseCapability.type === "message" &&
              run.userMessageId === `async-answer:${request.id}`)) &&
          request.threadReadContext?.records.some((record) =>
            matches(record.environmentId, record.threadId),
          )
        ) {
          const at = DateTime.toEpochMillis(request.resolvedAt);
          const original =
            request.responseCapability.type === "message" &&
            run.userMessageId === `async-answer:${request.id}` &&
            at <= DateTime.toEpochMillis(run.requestedAt) &&
            options.isOriginalInputReference !== undefined &&
            (yield* options.isOriginalInputReference(
              current.threadId,
              run.id,
              request.threadReadContext.authorizationId,
            ));
          if (at < before || original) {
            candidates.push({ nonce: request.threadReadContext.authorizationId, at, original });
          }
        }
      }
      candidates.sort((a, b) => b.at - a.at || Number(a.original) - Number(b.original));
      const latest = candidates[0];
      if (latest !== undefined) {
        if (
          candidates.some(
            (candidate) =>
              candidate.at === latest.at &&
              candidate.original === latest.original &&
              candidate.nonce !== latest.nonce,
          )
        )
          return { kind: "reference-denied", source: current };
        const key: ReferenceKey = {
          kind: "reference",
          threadId: current.threadId,
          grantId: latest.nonce,
        };
        const grant = yield* options.lookupReferenceGrant(current.threadId, latest.nonce);
        return grant === undefined
          ? { kind: "reference-denied", key, source: current }
          : { kind: "grant", key, source: current, grant };
      }
    }
    if (trigger === undefined) return general;
    const nextRunId = continuationSource(records, run, trigger);
    if (nextRunId === null) return general;
    const spawns = records.contextTransfers.filter(
      (transfer) => transfer.type === "subagent_spawn" && transfer.targetRunId === run.id,
    );
    if (nextRunId !== undefined && spawns.length > 0) return general;
    let next: Source;
    let cutoff = Math.min(before, DateTime.toEpochMillis(run.requestedAt));
    if (nextRunId !== undefined) {
      next = { threadId: current.threadId, runId: nextRunId };
    } else if (
      spawns.length === 1 &&
      spawns[0]!.status === "consumed" &&
      DateTime.toEpochMillis(spawns[0]!.createdAt) <= DateTime.toEpochMillis(run.requestedAt) &&
      spawns[0]!.targetThreadId === current.threadId &&
      spawns[0]!.sourcePoint.threadId === spawns[0]!.sourceThreadId &&
      spawns[0]!.sourcePoint.runId !== undefined
    ) {
      const spawn = spawns[0]!;
      next = { threadId: spawn.sourceThreadId, runId: spawn.sourcePoint.runId! };
      cutoff = Math.min(cutoff, DateTime.toEpochMillis(spawn.createdAt));
    } else return general;
    const nextRecords = yield* load(next.threadId);
    const source = nextRecords.runs.find((candidate) => candidate.id === next.runId);
    if (
      source === undefined ||
      source.threadId !== next.threadId ||
      DateTime.toEpochMillis(source.requestedAt) > cutoff ||
      (next.threadId === current.threadId && source.ordinal >= run.ordinal)
    )
      return general;
    current = next;
    before = cutoff;
  }
});
