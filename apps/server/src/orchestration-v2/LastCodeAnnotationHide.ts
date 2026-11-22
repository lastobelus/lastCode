import type {
  AnnotationHideTrigger,
  AnnotationHideTriggerInput,
  AnnotationReveal,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2InternalCommand,
  ThreadAnnotation,
} from "@t3tools/contracts";
import {
  compareLastCodeBuilds,
  parseLastCodeBuildKey,
  parseLastCodeVersion,
} from "@t3tools/shared/lastcodeVersionLabel";
import {
  threadAnnotationAuthoredBody,
  threadAnnotationId,
  threadAnnotationOf,
} from "@t3tools/shared/threadAnnotation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import packageJson from "../../package.json" with { type: "json" };
import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type AnnotationCommand = Extract<
  OrchestrationV2Command,
  { type: "thread.annotation.upsert" | "thread.annotation.resolve" | "thread.annotation.reopen" }
>;
export type AnnotationTriggerCommand = Extract<
  OrchestrationV2InternalCommand,
  { type: "thread.annotation.reveal" | "thread.annotation.hide-progress" }
>;

const GENERATED_BODY = "Thread annotation";

function matchesHideTrigger(
  command: Extract<AnnotationCommand, { type: "thread.annotation.upsert" }>,
  previous: ThreadAnnotation | null,
) {
  return (
    previous?.resolvedAt === null &&
    previous.hideUntil !== undefined &&
    previous.hideUntil.id === command.expectedHideTriggerId
  );
}

export function isStaleStandaloneAnnotationReveal(
  command: AnnotationCommand,
  previous: ThreadAnnotation | null,
) {
  return (
    command.type === "thread.annotation.upsert" &&
    command.hideUntil === null &&
    command.body === undefined &&
    !matchesHideTrigger(command, previous)
  );
}

export function allowsUnchangedAnnotation(
  command: OrchestrationV2Command | OrchestrationV2InternalCommand,
) {
  return (
    command.type === "thread.annotation.reveal" ||
    command.type === "thread.annotation.hide-progress" ||
    (command.type === "thread.annotation.upsert" &&
      command.hideUntil === null &&
      command.body === undefined)
  );
}

type TriggerTargetLookup = Pick<EventSinkV2Shape, "latestSequence"> &
  Pick<ProjectionStoreV2Shape, "findThread">;

const armTrigger = Effect.fn("LastCodeAnnotationHide.armTrigger")(function* (
  input: AnnotationHideTriggerInput,
  command: Extract<AnnotationCommand, { type: "thread.annotation.upsert" }>,
  hiddenAt: string,
  lookup: TriggerTargetLookup,
  version: string,
): Effect.fn.Return<
  AnnotationHideTrigger,
  | string
  | Effect.Error<ReturnType<TriggerTargetLookup["findThread"]>>
  | Effect.Error<ReturnType<TriggerTargetLookup["latestSequence"]>>
> {
  const common = { id: command.commandId, hiddenAt };
  switch (input.kind) {
    case "checkpoints":
      if (parseLastCodeVersion(version) === null) {
        return yield* Effect.fail(
          "This environment isn't running a LastCode checkpoint, so it can't count installs.",
        );
      }
      return { ...common, ...input, baselineVersion: version, seenBuilds: [] };
    case "date":
      if (Date.parse(input.at) <= Date.parse(hiddenAt)) {
        return yield* Effect.fail("Choose a future date to reveal this thread.");
      }
      return { ...common, ...input };
    case "thread-archived": {
      if (input.threadId === command.threadId) {
        return yield* Effect.fail(
          "A thread can't wait for itself to be archived. Choose another thread.",
        );
      }
      const afterTargetSequence = yield* lookup.latestSequence({ threadId: input.threadId });
      const target = yield* lookup.findThread(input.threadId);
      if (target === null || target.deletedAt !== null || target.archivedAt !== null) {
        return yield* Effect.fail(
          "That thread is already archived or no longer exists. Choose an active thread in this environment.",
        );
      }
      return { ...common, ...input, afterTargetSequence, targetTitle: target.title };
    }
    case "pull-request-merged":
      return { ...common, ...input };
  }
});

export const applyAnnotationEdit = Effect.fn("LastCodeAnnotationHide.applyAnnotationEdit")(
  function* (
    command: AnnotationCommand,
    note: Omit<ThreadAnnotation, "body">,
    previous: ThreadAnnotation | null,
    lookup: TriggerTargetLookup,
    version = packageJson.version,
  ) {
    const previousBody = threadAnnotationAuthoredBody(previous);
    if (command.type !== "thread.annotation.upsert") {
      return previousBody.trim() === "" ? null : { ...note, body: previousBody };
    }

    let hideUntil = previous?.hideUntil;
    let reveal = previous?.reveal;
    if (command.hideUntil && note.resolvedAt !== null) {
      return yield* Effect.fail("A resolved annotation can't hide its thread. Reopen it first.");
    }
    if (command.hideUntil) {
      hideUntil = yield* armTrigger(command.hideUntil, command, note.updatedAt, lookup, version);
      reveal = undefined;
    } else if (command.hideUntil === null && matchesHideTrigger(command, previous) && hideUntil) {
      reveal = { at: note.updatedAt, by: "manual", trigger: hideUntil };
      hideUntil = undefined;
    }

    const isLegacyGeneratedEcho =
      previous?.bodyGenerated === true &&
      command.bodyEdited !== true &&
      command.body === previous.body;
    const body = command.body === undefined || isLegacyGeneratedEcho ? previousBody : command.body;
    const hasBody = body.trim().length > 0;
    if (!hasBody && hideUntil === undefined && reveal === undefined) {
      return yield* Effect.fail("Add a note, or choose when the thread should come back.");
    }
    return {
      ...note,
      body: hasBody ? body : GENERATED_BODY,
      ...(!hasBody ? { bodyGenerated: true as const } : {}),
      ...(hideUntil === undefined ? {} : { hideUntil }),
      ...(reveal === undefined ? {} : { reveal }),
    };
  },
);

export function updateAnnotationHistory(
  notes: readonly ThreadAnnotation[],
  note: ThreadAnnotation | null,
  editedId: string,
): ThreadAnnotation | null {
  const remaining = notes.filter((entry) => entry.id !== editedId);
  const [head, ...otherAnnotations] = (note === null ? remaining : [note, ...remaining]).toSorted(
    (a, b) =>
      Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  if (head === undefined) return null;
  return otherAnnotations.length === 0 ? head : { ...head, otherAnnotations };
}

function advanceCheckpoint(
  trigger: Extract<AnnotationHideTrigger, { kind: "checkpoints" }>,
  version: string,
) {
  const build = parseLastCodeVersion(version);
  const baseline = parseLastCodeVersion(trigger.baselineVersion);
  if (build === null || baseline === null || compareLastCodeBuilds(build, baseline) <= 0)
    return null;
  if (
    trigger.seenBuilds.some((key) => {
      const observed = parseLastCodeBuildKey(key);
      return observed !== null && compareLastCodeBuilds(build, observed) <= 0;
    })
  )
    return null;
  return { ...trigger, seenBuilds: [...trigger.seenBuilds, build.key] };
}

export function applyAnnotationTriggerCommand(
  thread: OrchestrationV2AppThread | null,
  command: AnnotationTriggerCommand,
  now: DateTime.Utc,
  version = packageJson.version,
): OrchestrationV2AppThread | null {
  if (thread === null || thread.deletedAt !== null) return null;
  const annotation = threadAnnotationOf(thread);
  if (
    annotation?.resolvedAt !== null ||
    threadAnnotationId(annotation) !== command.annotationId ||
    annotation.hideUntil?.id !== command.triggerId
  )
    return null;

  const { hideUntil, ...note } = annotation;
  const at = DateTime.formatIso(now);
  let reveal: AnnotationReveal;
  if (command.type === "thread.annotation.hide-progress") {
    if (hideUntil.kind !== "checkpoints") return null;
    const progress = advanceCheckpoint(hideUntil, version);
    if (progress === null) return null;
    if (progress.seenBuilds.length < progress.count) {
      return { ...thread, annotation: { ...note, hideUntil: progress } };
    }
    reveal = {
      at,
      by: "trigger",
      trigger: progress,
      outcome: "installed",
      installedVersion: version,
    };
  } else {
    const { outcome } = command;
    const matches =
      (hideUntil.kind === "date" &&
        outcome === "due" &&
        Date.parse(hideUntil.at) <= Date.parse(at)) ||
      (hideUntil.kind === "thread-archived" && (outcome === "archived" || outcome === "deleted")) ||
      (hideUntil.kind === "pull-request-merged" &&
        (outcome === "merged" || outcome === "closed-unmerged"));
    if (!matches) return null;
    reveal = { at, by: "trigger", trigger: hideUntil, outcome };
  }
  return { ...thread, updatedAt: now, annotation: { ...note, updatedAt: at, reveal } };
}
