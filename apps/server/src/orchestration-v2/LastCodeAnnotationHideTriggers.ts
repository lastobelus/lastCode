import {
  CommandId,
  ProjectId,
  ThreadId,
  type AnnotationHideTrigger,
  type AnnotationRevealOutcome,
  type PullRequestRef,
} from "@t3tools/contracts";
import {
  compareLastCodeBuilds,
  parseLastCodeBuildKey,
  parseLastCodeVersion,
} from "@t3tools/shared/lastcodeVersionLabel";
import { threadAnnotationId, threadAnnotationOf } from "@t3tools/shared/threadAnnotation";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentPauseStore from "../environment/EnvironmentPauseStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const MINUTE_MS = 60_000;
const UNREADABLE_PR_RETRY_MINUTES = 15;
const PULL_REQUEST_KIND = "pull-request-merged";
const encodePullRequestGroupKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([ProjectId, Schema.String, Schema.String, Schema.Int])),
);

interface Candidate<Trigger extends AnnotationHideTrigger = AnnotationHideTrigger> {
  readonly annotationId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly trigger: Trigger;
}

type PullRequestCandidate = Candidate<
  Extract<AnnotationHideTrigger, { kind: typeof PULL_REQUEST_KIND }>
>;
type PullRequestOutcome = Extract<AnnotationRevealOutcome, "merged" | "closed-unmerged">;
type PullRequestAttempt =
  | { readonly state: "open" | "unreadable"; readonly at: number }
  | { readonly state: "final"; readonly outcome: PullRequestOutcome };

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

function needsCheckpointObservation(
  running: NonNullable<ReturnType<typeof parseLastCodeVersion>>,
  trigger: Extract<AnnotationHideTrigger, { kind: "checkpoints" }>,
) {
  const baseline = parseLastCodeVersion(trigger.baselineVersion);
  if (baseline === null || compareLastCodeBuilds(running, baseline) <= 0) return false;
  return trigger.seenBuilds.every((key) => {
    const seen = parseLastCodeBuildKey(key);
    return seen === null || compareLastCodeBuilds(running, seen) > 0;
  });
}

function nextPullRequestCheck(attempt: PullRequestAttempt | undefined, minutes: number) {
  if (attempt === undefined) return -Infinity;
  if (attempt.state === "final") return Infinity;
  const delay =
    attempt.state === "unreadable" ? Math.max(minutes, UNREADABLE_PR_RETRY_MINUTES) : minutes;
  return attempt.at + delay * MINUTE_MS;
}

export const make = Effect.fn("LastCodeAnnotationHideTriggers.make")(function* (version: string) {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* EventStore.EventStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const pauseStore = yield* EnvironmentPauseStore.EnvironmentPauseStore;
  const random = yield* SecureRandom.SecureRandom;
  const runningBuild = parseLastCodeVersion(version);
  const localDue = DueHint.make();
  const pullRequestDue = DueHint.make();
  const attempts = new Map<CommandId, PullRequestAttempt>();

  const afterSequence = yield* sink.latestSequence();
  for (const eventType of [
    "thread.annotation-upserted",
    "thread.annotation-resolved",
    "thread.annotation-reopened",
    "thread.archived",
    "thread.deleted",
  ] as const) {
    let cursor = afterSequence;
    yield* forkParked(
      Effect.suspend(() =>
        sink.stream({ afterSequence: cursor, eventType }).pipe(
          Stream.runForEach(({ sequence }) =>
            Effect.gen(function* () {
              yield* localDue.invalidate;
              if (eventType !== "thread.archived") yield* pullRequestDue.invalidate;
              cursor = sequence;
            }),
          ),
        ),
      ).pipe(
        Effect.tapCause(logFailure("Annotation hide event subscription failed", { eventType })),
        Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
      ),
    );
  }
  const settingsChanges = yield* settings.subscribeChanges;
  yield* forkParked(
    settingsChanges.pipe(
      Stream.map((value) => value.lastcodeAnnotationPrCheckMinutes),
      Stream.changesWith((previous, next) => previous === next),
      Stream.runForEach(() => pullRequestDue.invalidate),
    ),
  );

  const readCandidates = Effect.fn("LastCodeAnnotationHideTriggers.readCandidates")(function* (
    pullRequestsOnly: boolean,
  ) {
    const kind = sql`json_extract(payload_json, '$.annotation.hideUntil.kind')`;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_type(payload_json, '$.annotation.hideUntil') = 'object'
        AND ${pullRequestsOnly ? sql`${kind} = ${PULL_REQUEST_KIND}` : sql`${kind} <> ${PULL_REQUEST_KIND}`}
    `.pipe(NodeSqliteClient.readOnly);
    const candidates: Candidate[] = [];
    let incomplete = false;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      const thread = yield* projections.findThread(threadId).pipe(
        Effect.catchCause((cause) => {
          incomplete = true;
          return logFailure("Could not read annotation hide candidate", { threadId })(cause).pipe(
            Effect.as(null),
          );
        }),
      );
      if (thread === null || thread.deletedAt !== null) continue;
      const annotation = threadAnnotationOf(thread);
      const trigger = annotation?.hideUntil;
      if (
        annotation == null ||
        annotation.resolvedAt !== null ||
        trigger === undefined ||
        (trigger.kind === PULL_REQUEST_KIND) !== pullRequestsOnly
      )
        continue;
      candidates.push({
        annotationId: threadAnnotationId(annotation),
        threadId,
        projectId: thread.projectId,
        trigger,
      });
    }
    return { candidates, incomplete };
  });

  const dispatch = Effect.fn("LastCodeAnnotationHideTriggers.dispatch")(function* (
    candidate: Candidate,
    outcome?: AnnotationRevealOutcome,
  ) {
    const fields = {
      commandId: CommandId.make(yield* random.uuidV4()),
      threadId: candidate.threadId,
      annotationId: candidate.annotationId,
      triggerId: candidate.trigger.id,
    };
    yield* orchestrator.dispatch(
      outcome === undefined
        ? { type: "thread.annotation.hide-progress", ...fields }
        : { type: "thread.annotation.reveal", ...fields, outcome },
    );
  });

  const evaluateLocal = Effect.fn("LastCodeAnnotationHideTriggers.evaluateLocal")(function* (
    candidate: Candidate,
    now: number,
  ) {
    const { trigger } = candidate;
    switch (trigger.kind) {
      case "checkpoints":
        if (runningBuild !== null && needsCheckpointObservation(runningBuild, trigger)) {
          yield* dispatch(candidate);
        }
        break;
      case "date": {
        const dueAt = Date.parse(trigger.at);
        if (dueAt > now) return dueAt;
        yield* dispatch(candidate, "due");
        break;
      }
      case "thread-archived": {
        const query = {
          threadId: trigger.threadId,
          afterSequence: trigger.afterTargetSequence,
          limit: 1,
        };
        // Read deletion first so an archive committed before an observed deletion is visible.
        const deleted = yield* events
          .read({ ...query, eventType: "thread.deleted" })
          .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
        const archived = yield* events
          .read({ ...query, eventType: "thread.archived" })
          .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
        if (
          archived !== undefined &&
          (deleted === undefined || archived.sequence < deleted.sequence)
        ) {
          yield* dispatch(candidate, "archived");
        } else if (deleted !== undefined) {
          yield* dispatch(candidate, "deleted");
        }
        break;
      }
    }
    return Infinity;
  });

  const local = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (yield* localDue.isIdle(now)) return;
    const readVersion = yield* localDue.version;
    const { candidates, incomplete } = yield* readCandidates(false);
    let wakeAt = incomplete ? now : Infinity;
    for (const candidate of candidates) {
      const next = yield* evaluateLocal(candidate, now).pipe(
        Effect.catchCause((cause) =>
          logFailure("Annotation hide trigger failed", { threadId: candidate.threadId })(
            cause,
          ).pipe(Effect.as(now)),
        ),
      );
      wakeAt = Math.min(wakeAt, next);
    }
    yield* localDue.record(readVersion, wakeAt, now);
  });

  const pr = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (yield* pullRequestDue.isIdle(now)) return;
    const readVersion = yield* pullRequestDue.version;
    const { candidates, incomplete } = yield* readCandidates(true);
    const groups = new Map<string, { ref: PullRequestRef; candidates: PullRequestCandidate[] }>();
    const armed = new Set<CommandId>();
    for (const candidate of candidates) {
      const { trigger, projectId } = candidate;
      if (trigger.kind !== PULL_REQUEST_KIND) continue;
      const { host, repository, number } = trigger;
      const key = yield* encodePullRequestGroupKey([
        projectId,
        host.toLowerCase(),
        repository.toLowerCase(),
        number,
      ]);
      const target = { ...candidate, trigger };
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { ref: { projectId, host, repository, number }, candidates: [target] });
      } else {
        group.candidates.push(target);
      }
      armed.add(trigger.id);
    }
    if (!incomplete) {
      for (const id of attempts.keys()) {
        if (!armed.has(id)) attempts.delete(id);
      }
    }

    let wakeAt = incomplete ? now : Infinity;
    if (groups.size > 0) {
      const { lastcodeAnnotationPrCheckMinutes: minutes } = yield* settings.getSettings;
      for (const group of groups.values()) {
        const at = yield* Clock.currentTimeMillis;
        if (
          group.candidates.some(
            ({ trigger }) => nextPullRequestCheck(attempts.get(trigger.id), minutes) <= at,
          )
        ) {
          const pause = yield* pauseStore.get;
          if (pause === null || pause.phase === "resuming") {
            const observation = yield* pullRequests
              .summary(group.ref, { bypassCache: true, recoverTransientFailure: false })
              .pipe(
                Effect.map(({ state }): PullRequestAttempt =>
                  state === "open"
                    ? { state: "open", at }
                    : {
                        state: "final",
                        outcome: state === "merged" ? "merged" : "closed-unmerged",
                      },
                ),
                Effect.catchCause((cause) =>
                  logFailure("Annotation pull request lookup failed", { ref: group.ref })(
                    cause,
                  ).pipe(Effect.as<PullRequestAttempt>({ state: "unreadable", at })),
                ),
              );
            for (const { trigger } of group.candidates) {
              if (attempts.get(trigger.id)?.state !== "final")
                attempts.set(trigger.id, observation);
            }
          }
        }
        for (const candidate of group.candidates) {
          const attempt = attempts.get(candidate.trigger.id);
          if (attempt?.state === "final") {
            const next = yield* dispatch(candidate, attempt.outcome).pipe(
              Effect.as(Infinity),
              Effect.catchCause((cause) =>
                logFailure("Annotation pull request reveal failed", {
                  threadId: candidate.threadId,
                })(cause).pipe(Effect.as(now)),
              ),
            );
            wakeAt = Math.min(wakeAt, next);
          } else {
            wakeAt = Math.min(wakeAt, nextPullRequestCheck(attempt, minutes));
          }
        }
      }
    }
    yield* pullRequestDue.record(readVersion, wakeAt, now);
  });

  return { local, pr };
});

export const layerForVersion = (version: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      const sweeps = yield* make(version);
      yield* scheduler.register("annotation-hide-local", sweeps.local, { runWhilePaused: true });
      yield* scheduler.register("annotation-hide-pull-requests", sweeps.pr);
    }),
  );

export const layer = layerForVersion(packageJson.version).pipe(
  Layer.provide(
    Layer.mergeAll(
      Scheduler.layer,
      ProjectionStore.layer,
      EventStore.layerFromOrchestrationEventStore,
    ),
  ),
);
