import type {
  ActionResumeState,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import { CircleDashedIcon, InfoIcon, TerminalIcon } from "lucide-react";
import { useClientSetting } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

const secondaryTextClassName = "text-muted-foreground/60 light:text-muted-foreground/80";

export interface LastCodeCurrentWorkProps {
  readonly work: ThreadNowItem | null;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly action: ActionResumeState | null;
  readonly actionItems: ReadonlyArray<ComposerBannerStackItem | null>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

export function LastCodeCurrentWork({
  work,
  tasks,
  turnItems,
  action,
  actionItems,
  onOpenThread,
}: LastCodeCurrentWorkProps) {
  const hoverDetails = useClientSetting("hoverCurrentWorkDetails");
  const actions = actionItems.filter((item) => item !== null);
  const background = presentPendingBackgroundWork(tasks);
  const count = actions.length + (background?.items.length ?? 0);
  if (count === 0) return null;

  const runningPresentation =
    action?.outcome === "running" ? actionRunningPresentation(action) : null;
  const actionTitle =
    actions.length === 0 || action === null
      ? null
      : action.outcome === "running"
        ? `${runningPresentation?.state === "waiting" ? "Waiting for" : "Running"} ${action.actionName}`
        : typeof actions[0]?.title === "string"
          ? actions[0].title
          : action.actionName;
  const title = [actionTitle, background?.title].filter(Boolean).join(" · ");
  const needsAttention = actions.length > 0 && action?.outcome !== "running";
  const icon = actions[0]?.icon ?? work?.icon ?? <CircleDashedIcon />;
  const inlineActions = count === 1 ? (actions[0]?.actions ?? work?.actions) : undefined;

  return (
    <Popover>
      <div
        data-thread-now-line="true"
        data-lastcode-current-work="true"
        role={needsAttention ? "status" : undefined}
        className={cn(
          "mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
          "[&_button[data-slot=popover-trigger]]:-my-1.5",
          needsAttention ? "text-warning-foreground" : "text-muted-foreground",
        )}
      >
        <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
          {icon}
        </span>
        {hoverDetails ? (
          <PopoverTrigger
            openOnHover
            nativeButton={false}
            render={<span className="min-w-0 truncate" />}
          >
            {title}
          </PopoverTrigger>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <PopoverTrigger
          openOnHover
          render={<Button size="icon-xs" variant="ghost-muted" aria-label="Show work details" />}
        >
          <InfoIcon />
        </PopoverTrigger>
        {inlineActions ? (
          <span className="ms-1.5 flex shrink-0 items-center gap-2.5">{inlineActions}</span>
        ) : null}
      </div>
      <PopoverPopup
        aria-label="Current work"
        tooltipStyle
        side="top"
        className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
      >
        <ComposerBanner.Scroll className="max-h-[min(var(--available-height),24rem,40dvh)]">
          <div className="flex flex-col gap-1.5 font-normal" data-lastcode-work-list="true">
            <div className="text-muted-foreground">Current work · {count}</div>
            {actions.map((item) => (
              <div key={item.id} className="flex min-w-0 gap-2">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
                >
                  {item.icon}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {action?.outcome === "running" ? (
                    <div className="wrap-anywhere">{action.actionName}</div>
                  ) : null}
                  <div
                    className={cn("wrap-anywhere", runningPresentation && secondaryTextClassName)}
                  >
                    {runningPresentation
                      ? `${runningPresentation.label} ${runningPresentation.summary}`
                      : item.title}
                  </div>
                  {item.description ? (
                    <div className={secondaryTextClassName}>{item.description}</div>
                  ) : null}
                  {item.children}
                  {item.actions ? <div className="flex flex-wrap gap-2">{item.actions}</div> : null}
                </div>
              </div>
            ))}
            {background?.items.map((task) => {
              const item = turnItems.findLast(
                (candidate) => (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId,
              );
              const subagent = item?.type === "subagent" ? item : null;
              const childThreadId = task.childThreadId ?? subagent?.childThreadId;
              return (
                <div key={task.taskId} className="flex min-w-0 gap-2">
                  <span
                    aria-hidden
                    className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
                  >
                    {task.kind === "subagent" ? <CircleDashedIcon /> : <TerminalIcon />}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="wrap-anywhere">{task.label}</div>
                    {subagent?.progress ? (
                      <div className={cn("wrap-anywhere", secondaryTextClassName)}>
                        {subagent.progress}
                      </div>
                    ) : null}
                    {childThreadId != null && background.items.length > 1 ? (
                      <InlineButton tone="muted" onClick={() => onOpenThread(childThreadId)}>
                        Open thread
                      </InlineButton>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {work?.actions ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Background work</span>
                {work.actions}
              </div>
            ) : null}
          </div>
        </ComposerBanner.Scroll>
      </PopoverPopup>
    </Popover>
  );
}
