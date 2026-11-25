import type {
  AnnotationHideTrigger,
  AnnotationHideTriggerInput,
  AnnotationReveal,
  CommandId,
  ThreadAnnotation,
  ThreadId,
} from "@t3tools/contracts";
import { formatLastCodeVersion, parseLastCodeVersion } from "@t3tools/shared/lastcodeVersionLabel";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export interface AnnotationEdit {
  readonly body?: string;
  readonly bodyEdited?: true;
  readonly hideUntil?: AnnotationHideTriggerInput | null;
  readonly expectedHideTriggerId?: CommandId;
}

type PullRequestTrigger = Extract<AnnotationHideTriggerInput, { kind: "pull-request-merged" }>;
type DateDraft = { kind: "date"; date: string; time: string; presetAt?: number };
export type HideUntilDraft =
  | { kind: "none" }
  | { kind: "checkpoints"; count: string }
  | { kind: "thread-archived"; threadId: ThreadId | null }
  | { kind: "pull-request-merged"; pullRequest: PullRequestTrigger | null }
  | DateDraft;

function localDateFields(value: string | number) {
  const local = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return {
    date: `${String(local.getFullYear()).padStart(4, "0")}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
  };
}

type CalendarPreset = "tomorrow" | "monday" | "week";
function calendarDatePreset(date: string, preset: CalendarPreset): DateDraft {
  const day = DateTime.makeUnsafe(`${date}T00:00:00Z`);
  const days =
    preset === "week" ? 7 : preset === "monday" ? (8 - DateTime.toParts(day).weekDay) % 7 || 7 : 1;
  return {
    kind: "date",
    date: DateTime.formatIsoDateUtc(DateTime.add(day, { days })),
    time: "09:00",
  };
}

export function annotationDatePreset(
  now: number,
  preset: CalendarPreset | "hour" | "afternoon" | "tonight",
): DateDraft | null {
  if (preset === "hour") {
    const presetAt = now + 60 * 60 * 1000;
    // The displayed minute cannot distinguish the two occurrences of a repeated local hour.
    return { kind: "date", ...localDateFields(presetAt), presetAt };
  }
  const { date } = localDateFields(now);
  if (preset === "afternoon" || preset === "tonight") {
    const time = preset === "afternoon" ? "13:00" : "19:00";
    return futureLocalInstant(date, time, now) === null ? null : { kind: "date", date, time };
  }
  return calendarDatePreset(date, preset);
}

export function makeHideUntilDraft(kind: HideUntilDraft["kind"], now: number): HideUntilDraft {
  switch (kind) {
    case "none":
      return { kind };
    case "checkpoints":
      return { kind, count: "1" };
    case "thread-archived":
      return { kind, threadId: null };
    case "pull-request-merged":
      return { kind, pullRequest: null };
    case "date":
      return calendarDatePreset(localDateFields(now).date, "tomorrow");
  }
}

export function storedHideUntilDraft(trigger: AnnotationHideTrigger | undefined): HideUntilDraft {
  if (!trigger) return { kind: "none" };
  switch (trigger.kind) {
    case "checkpoints":
      return { kind: trigger.kind, count: String(trigger.count) };
    case "thread-archived":
      return { kind: trigger.kind, threadId: trigger.threadId };
    case "pull-request-merged": {
      const { kind, repository, host, number } = trigger;
      return { kind, pullRequest: { kind, repository, host, number } };
    }
    case "date":
      return { kind: trigger.kind, ...localDateFields(trigger.at) };
  }
}

function futureLocalInstant(date: string, time: string, now: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^\d{2}:\d{2}$/u.test(time)) return null;
  const input = `${date}T${time}:00.000Z`;
  const instant = DateTime.makeZoned(input, {
    timeZone: DateTime.zoneMakeLocal(),
    adjustForTimeZone: true,
    disambiguation: "reject",
  });
  if (Option.isNone(instant) || DateTime.toEpochMillis(instant.value) <= now) return null;
  const fields = localDateFields(DateTime.toEpochMillis(instant.value));
  return fields.date === date && fields.time === time ? DateTime.formatIso(instant.value) : null;
}

export function annotationTriggerInput(
  draft: HideUntilDraft,
  serverVersion: string | undefined,
  now: number,
): AnnotationHideTriggerInput | null {
  switch (draft.kind) {
    case "none":
      return null;
    case "checkpoints": {
      const count = Number(draft.count);
      return /^\d+$/u.test(draft.count) &&
        Number.isSafeInteger(count) &&
        count > 0 &&
        serverVersion !== undefined &&
        parseLastCodeVersion(serverVersion) !== null
        ? { kind: draft.kind, count }
        : null;
    }
    case "thread-archived":
      return draft.threadId === null ? null : { kind: draft.kind, threadId: draft.threadId };
    case "pull-request-merged":
      return draft.pullRequest;
    case "date": {
      const at =
        draft.presetAt === undefined
          ? futureLocalInstant(draft.date, draft.time, now)
          : draft.presetAt > now
            ? new Date(draft.presetAt).toISOString()
            : null;
      return at === null ? null : { kind: draft.kind, at };
    }
  }
}

function sameHideUntilDraft(left: HideUntilDraft, right: HideUntilDraft): boolean {
  switch (left.kind) {
    case "none":
      return right.kind === left.kind;
    case "checkpoints":
      return right.kind === left.kind && Number(right.count) === Number(left.count);
    case "thread-archived":
      return right.kind === left.kind && right.threadId === left.threadId;
    case "pull-request-merged":
      return (
        right.kind === left.kind &&
        right.pullRequest?.host === left.pullRequest?.host &&
        right.pullRequest?.repository === left.pullRequest?.repository &&
        right.pullRequest?.number === left.pullRequest?.number
      );
    case "date":
      return (
        right.kind === left.kind &&
        right.date === left.date &&
        right.time === left.time &&
        right.presetAt === left.presetAt
      );
  }
}

export function showThreadNow(trigger: AnnotationHideTrigger): AnnotationEdit {
  return { hideUntil: null, expectedHideTriggerId: trigger.id };
}

/** Null means the selected trigger is incomplete or invalid. */
export function annotationTriggerEdit(
  trigger: AnnotationHideTrigger | undefined,
  draft: HideUntilDraft,
  serverVersion: string | undefined,
  now: number,
): AnnotationEdit | null {
  if (sameHideUntilDraft(draft, storedHideUntilDraft(trigger))) return {};
  if (draft.kind === "none" && trigger) return showThreadNow(trigger);
  const hideUntil = annotationTriggerInput(draft, serverVersion, now);
  return hideUntil === null ? null : { hideUntil };
}

export function canSaveAnnotationEdit(
  hasBody: boolean,
  annotation: ThreadAnnotation | null,
  triggerEdit: AnnotationEdit | null,
): boolean {
  return (
    triggerEdit !== null &&
    (hasBody || Boolean(annotation?.hideUntil || annotation?.reveal || triggerEdit.hideUntil))
  );
}

/** An undefined edit is invalid. An omitted field preserves the server's current value. */
export function annotationEditorEdit(input: {
  body: string;
  originalBody: string;
  annotation: ThreadAnnotation | null;
  draft: HideUntilDraft;
  serverVersion: string | undefined;
  supportsHideUntil: boolean;
  now: number;
}): AnnotationEdit | undefined {
  const body = input.body.trim();
  if (!input.supportsHideUntil) return body === "" ? undefined : { body };

  const triggerEdit = annotationTriggerEdit(
    input.annotation?.hideUntil,
    input.draft,
    input.serverVersion,
    input.now,
  );
  if (!canSaveAnnotationEdit(body !== "", input.annotation, triggerEdit)) return undefined;
  const bodyEdit = body !== input.originalBody.trim() ? { body, bodyEdited: true as const } : {};
  return { ...triggerEdit, ...bodyEdit };
}

export function formatAnnotationDateTime(at: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(at));
}

export function annotationTriggerSummary(
  trigger: AnnotationHideTrigger,
  targetTitle: string | undefined,
  locale: string,
  resolve: MessageResolver = m,
): string {
  switch (trigger.kind) {
    case "checkpoints":
      return resolve(
        msg(
          "{count, plural, one {until the next checkpoint is installed} other {until the next # checkpoints are installed}}",
          { count: trigger.count },
        ),
      );
    case "thread-archived":
      return resolve(
        msg("until {thread} is archived", {
          thread: targetTitle ?? trigger.targetTitle ?? resolve(msg("the selected thread")),
        }),
      );
    case "pull-request-merged":
      return resolve(msg("until PR #{number} is merged", { number: trigger.number }));
    case "date":
      return resolve(
        msg("until {dateTime}", { dateTime: formatAnnotationDateTime(trigger.at, locale) }),
      );
  }
}

export function annotationRevealReason(
  reveal: AnnotationReveal,
  targetTitle: string | undefined,
  locale: string,
  resolve: MessageResolver = m,
): string {
  const { trigger, installedVersion } = reveal;
  if (reveal.by === "manual") {
    switch (trigger.kind) {
      case "checkpoints":
        return resolve(
          msg(
            "{count, plural, one {Was waiting for the next checkpoint to install} other {Was waiting for the next # checkpoints to install}}",
            { count: trigger.count },
          ),
        );
      case "thread-archived":
        return resolve(
          msg("Was waiting for {thread} to be archived", {
            thread: targetTitle ?? trigger.targetTitle ?? resolve(msg("the selected thread")),
          }),
        );
      case "pull-request-merged":
        return resolve(msg("Was hidden until PR #{number} merged", { number: trigger.number }));
      case "date":
        return resolve(
          msg("Was hidden until {dateTime}", {
            dateTime: formatAnnotationDateTime(trigger.at, locale),
          }),
        );
    }
  }
  switch (trigger.kind) {
    case "checkpoints": {
      const count = trigger.count;
      return installedVersion === undefined
        ? resolve(
            msg("{count, plural, one {# checkpoint installed} other {# checkpoints installed}}", {
              count,
            }),
          )
        : resolve(
            msg(
              "{count, plural, one {# checkpoint installed} other {# checkpoints installed}}, now {version}",
              { count, version: formatLastCodeVersion(installedVersion) },
            ),
          );
    }
    case "thread-archived": {
      const thread = targetTitle ?? trigger.targetTitle ?? resolve(msg("The selected thread"));
      return reveal.outcome === "deleted"
        ? resolve(msg("{thread} was deleted", { thread }))
        : resolve(msg("{thread} was archived", { thread }));
    }
    case "pull-request-merged":
      return reveal.outcome === "closed-unmerged"
        ? resolve(msg("PR #{number} was closed without merging", { number: trigger.number }))
        : resolve(msg("PR #{number} was merged", { number: trigger.number }));
    case "date":
      return resolve(msg("Scheduled time reached"));
  }
}

export function annotationRevealFailed(reveal: AnnotationReveal) {
  return reveal.outcome === "closed-unmerged" || reveal.outcome === "deleted";
}
