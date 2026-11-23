import type { AnnotationHideTrigger, AnnotationReveal, ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { threadPullRequestKeyOf } from "@t3tools/client-runtime/thread-pull-requests";
import { formatLastCodeVersion } from "@t3tools/shared/lastcodeVersionLabel";
import { Link } from "@tanstack/react-router";
import { msg, useLocale, useMessages } from "gt-react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useServerConfigs, useProject, useQuietThreadShell } from "../../state/entities";
import { useSharedPullRequestSummary } from "../../state/pullRequests";
import {
  annotationRevealFailed,
  annotationRevealReason,
  annotationTriggerSummary,
  formatAnnotationPacificDate,
  formatAnnotationPacificTime,
} from "./threadAnnotationHideUntil.logic";

function useArchiveTarget(threadRef: ScopedThreadRef, trigger: AnnotationHideTrigger) {
  return useQuietThreadShell(
    trigger.kind === "thread-archived"
      ? scopeThreadRef(threadRef.environmentId, trigger.threadId)
      : null,
  );
}

export function ThreadAnnotationHideSummary({
  trigger,
  threadRef,
}: {
  trigger: AnnotationHideTrigger;
  threadRef: ScopedThreadRef;
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const target = useArchiveTarget(threadRef, trigger);
  return annotationTriggerSummary(trigger, target?.title, locale, resolve);
}

export function ThreadAnnotationRevealSummary({
  reveal,
  threadRef,
}: {
  reveal: AnnotationReveal;
  threadRef: ScopedThreadRef;
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const target = useArchiveTarget(threadRef, reveal.trigger);
  const dateTime = formatAnnotationPacificTime(reveal.at, locale);
  const reason = annotationRevealReason(reveal, target?.title, locale, resolve);
  const summary =
    reveal.by === "manual"
      ? resolve(msg("Shown manually {dateTime} PT. {reason}", { dateTime, reason }))
      : resolve(msg("Reappeared {dateTime} PT. {reason}", { dateTime, reason }));
  return (
    <span className={annotationRevealFailed(reveal) ? "text-destructive" : undefined}>
      {summary}
    </span>
  );
}

export function ThreadAnnotationHiddenSince({ at }: { at: string }) {
  const resolve = useMessages();
  const locale = useLocale();
  return resolve(
    msg("Hidden since {dateTime} PT", { dateTime: formatAnnotationPacificTime(at, locale) }),
  );
}

function PullRequestTriggerLink({
  threadRef,
  trigger,
  label,
}: {
  threadRef: ScopedThreadRef;
  trigger: Extract<AnnotationHideTrigger, { kind: "pull-request-merged" }>;
  label: string;
}) {
  const shell = useQuietThreadShell(threadRef);
  const project = useProject(
    shell ? scopeProjectRef(threadRef.environmentId, shell.projectId) : null,
  );
  const key = threadPullRequestKeyOf(trigger);
  const linked = shell?.pullRequests.find((link) => threadPullRequestKeyOf(link) === key);
  const identity = project?.repositoryIdentity;
  const projectHost = identity?.canonicalKey.split("/")[0]?.toLowerCase();
  const url =
    linked?.url ??
    (projectHost === trigger.host.toLowerCase()
      ? projectChangeRequestUrl(identity, trigger.repository, trigger.number)
      : null);
  const resolve = useMessages();
  const observed = useSharedPullRequestSummary(
    threadRef.environmentId,
    project
      ? {
          projectId: project.id,
          host: trigger.host,
          repository: trigger.repository,
          number: trigger.number,
        }
      : null,
  );
  const isOpen = (observed?.state ?? linked?.snapshot?.state) === "open";
  const checksPending = (observed?.checksState ?? linked?.snapshot?.checksState) === "pending";
  return (
    <>
      {url === null ? (
        label
      ) : (
        <a className="underline underline-offset-2" href={url} target="_blank" rel="noreferrer">
          {label}
        </a>
      )}
      {isOpen ? (
        <div className="mt-0.5 text-2xs text-warning-foreground/80">
          {checksPending
            ? resolve(msg("PR #{number} is open · checks pending", { number: trigger.number }))
            : resolve(msg("PR #{number} is open", { number: trigger.number }))}
        </div>
      ) : null}
    </>
  );
}

function CheckpointProgress({
  trigger,
  threadRef,
}: {
  trigger: Extract<AnnotationHideTrigger, { kind: "checkpoints" }>;
  threadRef: ScopedThreadRef;
}) {
  const resolve = useMessages();
  const configs = useServerConfigs();
  const version = formatLastCodeVersion(
    configs.get(threadRef.environmentId)?.environment.serverVersion ?? trigger.baselineVersion,
  );
  const seen = trigger.seenBuilds.length;
  const markers = Math.min(trigger.count, 10);
  const filled = Math.floor((seen / trigger.count) * markers);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-warning-foreground/80">
      <span aria-hidden className="flex gap-0.5">
        {Array.from({ length: markers }, (_, index) => (
          <span
            key={index}
            className={
              index < filled
                ? "size-1.5 rounded-full bg-current"
                : "size-1.5 rounded-full border border-current"
            }
          />
        ))}
      </span>
      <span>
        {resolve(
          msg("{seen} of {count} installed · now on {version}", {
            seen,
            count: trigger.count,
            version,
          }),
        )}
      </span>
    </div>
  );
}

export function ThreadAnnotationHiddenLine({
  trigger,
  threadRef,
}: {
  trigger: AnnotationHideTrigger;
  threadRef: ScopedThreadRef;
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const target = useArchiveTarget(threadRef, trigger);
  const when = annotationTriggerSummary(trigger, target?.title, locale, resolve);
  const label = resolve(msg("Hidden {trigger}", { trigger: when }));

  return (
    <div className="flex items-start gap-1.5 text-xs text-warning-foreground">
      <EyeOffIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        {trigger.kind === "pull-request-merged" ? (
          <PullRequestTriggerLink label={label} threadRef={threadRef} trigger={trigger} />
        ) : trigger.kind === "thread-archived" && target ? (
          <Link
            className="underline underline-offset-2"
            params={{ environmentId: threadRef.environmentId, threadId: target.id }}
            to="/$environmentId/$threadId"
          >
            {label}
          </Link>
        ) : (
          label
        )}
        {trigger.kind === "checkpoints" ? (
          <CheckpointProgress trigger={trigger} threadRef={threadRef} />
        ) : (
          <div className="mt-0.5 text-2xs text-warning-foreground/80">
            {trigger.kind === "thread-archived" && target?.runtime?.status === "running" ? (
              <>{resolve(msg("That thread is running"))} · </>
            ) : null}
            <ThreadAnnotationHiddenSince at={trigger.hiddenAt} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadAnnotationRevealLine({
  reveal,
  threadRef,
}: {
  reveal: AnnotationReveal;
  threadRef: ScopedThreadRef;
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const target = useArchiveTarget(threadRef, reveal.trigger);
  const dateTime = formatAnnotationPacificTime(reveal.at, locale);
  const reason = annotationRevealReason(reveal, target?.title, locale, resolve);
  const from = formatAnnotationPacificDate(reveal.trigger.hiddenAt, locale);
  const to = formatAnnotationPacificDate(reveal.at, locale);
  return (
    <div className="flex items-start gap-1.5 text-xs text-warning-foreground">
      <EyeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium">
          {reveal.by === "manual"
            ? resolve(msg("Shown manually {dateTime} PT", { dateTime }))
            : resolve(msg("Reappeared {dateTime} PT", { dateTime }))}
        </span>
        <div className="mt-0.5 text-2xs text-warning-foreground/80">
          <span className={annotationRevealFailed(reveal) ? "block text-destructive" : undefined}>
            {reason}
          </span>
          {!annotationRevealFailed(reveal) ? " · " : null}
          {resolve(msg("hidden {from} – {to} PT", { from, to }))}
        </div>
      </div>
    </div>
  );
}
