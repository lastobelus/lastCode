import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import {
  actionResultDetails,
  actionResultPresentation,
  parseActionResumeFollowUp,
  type ActionResultDetail,
  type ActionResumeFollowUp,
} from "@t3tools/shared/actionResume";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

type Props = {
  text: string;
  expanded: boolean;
  onToggle: () => void;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
};

const outcomeStyles = {
  success: { tone: "border-success/25 bg-success/6 text-success-foreground", icon: CheckIcon },
  error: { tone: "border-error/25 bg-error/6 text-error-foreground", icon: XIcon },
  cancelled: { tone: "border-border bg-muted/30 text-muted-foreground", icon: XIcon },
  blocked: { tone: "border-info/25 bg-info/6 text-info-foreground", icon: CircleAlertIcon },
  attention: {
    tone: "border-warning/28 bg-warning/8 text-warning-foreground",
    icon: CircleAlertIcon,
  },
};

export function LastCodeActionResultMessage({
  text,
  expanded,
  onToggle,
  cwd,
  threadRef,
  skills,
}: Props) {
  const followUp = parseActionResumeFollowUp(text);
  if (!followUp) {
    return <AutomatedFollowUp text={text} cwd={cwd} threadRef={threadRef} skills={skills} />;
  }
  const presentation = actionResultPresentation(followUp);
  const details = actionResultDetails(followUp.report);
  const expandable = !followUp.detailedOutputAvailable || details.length > 0;
  const { tone, icon: OutcomeIcon } = outcomeStyles[presentation.outcome];
  const heading = (
    <>
      <OutcomeIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {presentation.label}: {followUp.actionName}
      </span>
    </>
  );
  return (
    <div className={cn("mx-1 overflow-hidden rounded-lg border", tone)}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex w-full min-w-0 items-center gap-1.5 px-3 pt-2.5 text-left text-xs font-medium"
          onClick={onToggle}
        >
          {heading}
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          )}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pt-2.5 text-left text-xs font-medium">
          {heading}
        </div>
      )}
      <ActionResultBody
        followUp={followUp}
        summary={presentation.summary}
        details={details}
        expanded={expanded}
      />
    </div>
  );
}

function ActionResultBody({
  followUp,
  summary,
  details,
  expanded,
}: {
  followUp: ActionResumeFollowUp;
  summary: string;
  details: ReadonlyArray<ActionResultDetail>;
  expanded: boolean;
}) {
  if (!followUp.detailedOutputAvailable && expanded) {
    return (
      <pre className="mx-2.5 mb-2.5 mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-black/10 bg-code px-3 py-2.5 font-mono text-xs leading-5 text-code-foreground shadow-inner dark:border-white/10">
        {followUp.output}
      </pre>
    );
  }
  return (
    <div className="px-3 pb-2.5 pt-1">
      <p className="truncate text-sm text-foreground/90">{summary}</p>
      {details.length > 0 && expanded ? <ActionDetails details={details} /> : null}
      {followUp.detailedOutputAvailable && details.length === 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Detailed output retained in the Action terminal.
        </p>
      ) : null}
    </div>
  );
}

function ActionDetails({ details }: { details: ReadonlyArray<ActionResultDetail> }) {
  return (
    <dl className="mt-2 space-y-1.5 text-xs text-foreground/90">
      {details.map((detail) => (
        <div key={detail.id} className="min-w-0">
          <dt className="font-medium text-muted-foreground">{detail.label}</dt>
          <dd className="break-words">
            {detail.href ? (
              <a
                href={detail.href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {detail.value}
              </a>
            ) : (
              detail.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AutomatedFollowUp({
  text,
  cwd,
  threadRef,
  skills,
}: Pick<Props, "text" | "cwd" | "threadRef" | "skills">) {
  return (
    <div className="mx-1 rounded-lg border border-warning/25 bg-warning/6 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning-foreground">
        <BotIcon aria-hidden className="size-3.5" />
        Automated follow-up
      </div>
      <div className="text-sm text-foreground/90">
        <ChatMarkdown
          text={text}
          cwd={cwd}
          threadRef={threadRef}
          isStreaming={false}
          lineBreaks
          skills={skills}
        />
      </div>
    </div>
  );
}
