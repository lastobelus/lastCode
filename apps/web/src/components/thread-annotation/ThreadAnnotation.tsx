import {
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  type ScopedThreadRef,
  type ThreadAnnotation as ThreadAnnotationModel,
} from "@t3tools/contracts";
import {
  isThreadAnnotationHidden,
  threadAnnotationAuthoredBody,
} from "@t3tools/shared/threadAnnotation";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { ChevronDownIcon, EyeOffIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { setMarkdownTaskChecked } from "../../markdownTaskList";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "../chat/ComposerBanner";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  ThreadAnnotationHiddenLine,
  ThreadAnnotationHiddenSince,
  ThreadAnnotationHideSummary,
  ThreadAnnotationRevealLine,
  ThreadAnnotationRevealSummary,
} from "./ThreadAnnotationHideStatus";
import { ThreadAnnotationHideUntilField } from "./ThreadAnnotationHideUntilField";
import {
  annotationEditorEdit,
  annotationTriggerEdit,
  canSaveAnnotationEdit,
  storedHideUntilDraft,
  type AnnotationEdit,
} from "./threadAnnotationHideUntil.logic";

const pendingBodyChanges = new Set<string>();
const pendingBodyChangeListeners = new Map<string, Set<() => void>>();

function setBodyChangePending(threadKey: string, pending: boolean) {
  if (pending) pendingBodyChanges.add(threadKey);
  else pendingBodyChanges.delete(threadKey);
  pendingBodyChangeListeners.get(threadKey)?.forEach((listener) => listener());
}

function subscribeToBodyChange(threadKey: string | null, listener: () => void) {
  if (!threadKey) return () => undefined;
  const listeners = pendingBodyChangeListeners.get(threadKey) ?? new Set();
  listeners.add(listener);
  pendingBodyChangeListeners.set(threadKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingBodyChangeListeners.delete(threadKey);
  };
}

export function useThreadAnnotationBodyPending(threadRef: ScopedThreadRef | null): boolean {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  return useSyncExternalStore(
    (listener) => subscribeToBodyChange(threadKey, listener),
    () => (threadKey ? pendingBodyChanges.has(threadKey) : false),
    () => false,
  );
}

export async function runThreadAnnotationBodySave(
  threadRef: ScopedThreadRef,
  save: () => Promise<boolean>,
): Promise<boolean> {
  const threadKey = scopedThreadKey(threadRef);
  if (pendingBodyChanges.has(threadKey)) return false;
  setBodyChangePending(threadKey, true);
  try {
    return await save();
  } finally {
    setBodyChangePending(threadKey, false);
  }
}

export function ThreadAnnotationEditorDialog(props: {
  annotation: ThreadAnnotationModel | null;
  hideUntil?: { threadRef: ScopedThreadRef; serverVersion: string | undefined } | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (edit: AnnotationEdit) => Promise<boolean>;
}) {
  const gt = useGT();
  // The textarea owns its draft so typing does not rerender the dialog on every keystroke.
  const [original, setOriginal] = useState(props.annotation);
  const [draft, setDraft] = useState(() => storedHideUntilDraft(props.annotation?.hideUntil));
  const [hasBody, setHasBody] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wasOpenRef = useRef(false);
  const originalBody = threadAnnotationAuthoredBody(original);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- snapshots the annotation and initializes the uncontrolled textarea when the dialog opens
  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!justOpened) return;
    const body = threadAnnotationAuthoredBody(props.annotation);
    if (textareaRef.current) textareaRef.current.value = body;
    setHasBody(body.trim().length > 0);
    setOriginal(props.annotation);
    setDraft(storedHideUntilDraft(props.annotation?.hideUntil));
    setNow(Date.now());
    setSaving(false);
  }, [props.annotation, props.open]);

  const triggerEdit = props.hideUntil
    ? annotationTriggerEdit(original?.hideUntil, draft, props.hideUntil.serverVersion, now)
    : null;
  const canSave = props.hideUntil ? canSaveAnnotationEdit(hasBody, original, triggerEdit) : hasBody;
  const willHide =
    draft.kind !== "none" && (triggerEdit === null || Boolean(triggerEdit.hideUntil));
  const hideUntilField = original?.resolvedAt == null ? props.hideUntil : undefined;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    const edit = annotationEditorEdit({
      annotation: original,
      body: textareaRef.current?.value ?? "",
      originalBody,
      draft,
      serverVersion: props.hideUntil?.serverVersion,
      supportsHideUntil: props.hideUntil !== undefined,
      now: Date.now(),
    });
    if (edit === undefined) return;
    setSaving(true);
    const saved = Object.keys(edit).length === 0 || (await props.onSave(edit));
    setSaving(false);
    if (saved) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.annotation ? gt("Edit annotation") : gt("Annotate thread")}
          </DialogTitle>
          <DialogDescription>
            {original?.hideUntil ? (
              <ThreadAnnotationHiddenSince at={original.hideUntil.hiddenAt} />
            ) : original?.reveal && props.hideUntil ? (
              <ThreadAnnotationRevealSummary
                reveal={original.reveal}
                threadRef={props.hideUntil.threadRef}
              />
            ) : (
              <T>
                <Var>{"Markdown"}</Var> supports headings, lists, task lists, links, and tags.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <Textarea
              ref={textareaRef}
              defaultValue={originalBody}
              aria-label={gt("Thread annotation")}
              autoFocus
              className={
                hideUntilField
                  ? "[&_[data-slot=textarea]]:h-32 [&_[data-slot=textarea]]:field-sizing-fixed [&_[data-slot=textarea]]:resize-none"
                  : "[&_[data-slot=textarea]]:h-52 [&_[data-slot=textarea]]:field-sizing-fixed [&_[data-slot=textarea]]:resize-none"
              }
              disabled={saving}
              maxLength={THREAD_ANNOTATION_MAX_BODY_CHARS}
              placeholder={
                hideUntilField && draft.kind !== "none"
                  ? gt("Optional when hiding: why come back to it?")
                  : "# Follow up\n\n- [ ] Next step\n- #tag"
              }
              variant="code"
              onChange={(event) => setHasBody(event.target.value.trim().length > 0)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {hideUntilField ? (
              <ThreadAnnotationHideUntilField
                disabled={saving}
                draft={draft}
                invalid={triggerEdit === null}
                now={now}
                serverVersion={hideUntilField.serverVersion}
                threadRef={hideUntilField.threadRef}
                onChange={setDraft}
              />
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button disabled={!canSave || saving} form={formId} type="submit">
            {saving ? (
              gt("Saving…")
            ) : willHide ? (
              <>
                <EyeOffIcon aria-hidden className="size-4" />
                <T>Hide thread</T>
              </>
            ) : props.annotation ? (
              gt("Save", { $context: "save the annotation" })
            ) : (
              gt("Add annotation")
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadAnnotationTimestamp({ annotation }: { annotation: ThreadAnnotationModel }) {
  const resolve = useMessages();
  const timestamp = annotation.resolvedAt ?? annotation.updatedAt;
  const time = formatRelativeTimeLabel(timestamp, undefined, resolve);
  return (
    <span className="text-2xs text-warning-foreground">
      {annotation.resolvedAt
        ? resolve(msg("Resolved {time}", { time }))
        : resolve(msg("Edited {time}", { time }))}
    </span>
  );
}

export function ThreadAnnotationBody(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  className?: string;
  compact?: boolean;
  showTimestamp?: boolean;
  onBodyChange?: ((body: string) => Promise<boolean>) | undefined;
}) {
  const bodyChangePending = useThreadAnnotationBodyPending(props.threadRef);
  const body = threadAnnotationAuthoredBody(props.annotation);
  const trigger = isThreadAnnotationHidden(props.annotation)
    ? props.annotation.hideUntil
    : undefined;
  const reveal = props.annotation.resolvedAt === null ? props.annotation.reveal : undefined;

  const onTaskListChange = props.onBodyChange
    ? ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
        const nextBody = setMarkdownTaskChecked(body, markerOffset, checked);
        if (nextBody === body) return;
        void props.onBodyChange!(nextBody);
      }
    : undefined;

  return (
    <div className={props.className}>
      {trigger ? (
        <ThreadAnnotationHiddenLine trigger={trigger} threadRef={props.threadRef} />
      ) : null}
      {reveal ? <ThreadAnnotationRevealLine reveal={reveal} threadRef={props.threadRef} /> : null}
      {body !== "" ? (
        <div className={trigger || reveal ? "mt-2" : undefined}>
          <ChatMarkdown
            className={
              props.compact ? "thread-annotation-compact" : "text-sm text-warning-foreground"
            }
            cwd={props.cwd}
            onTaskListChange={onTaskListChange}
            parseRawHtml={false}
            taskListDisabled={bodyChangePending}
            text={body}
            threadRef={props.threadRef}
          />
        </div>
      ) : null}
      {body !== "" && props.showTimestamp !== false ? (
        <ThreadAnnotationTimestamp annotation={props.annotation} />
      ) : null}
    </div>
  );
}

export function threadAnnotationBannerPresentation(
  props: {
    annotation: ThreadAnnotationModel;
    threadRef: ScopedThreadRef;
    cwd?: string | undefined;
    expanded: boolean;
    onBodyChange?: ((body: string) => Promise<boolean>) | undefined;
  },
  resolve: MessageResolver = m,
): Pick<ComposerBannerStackItem, "title" | "description" | "children"> {
  const trigger = isThreadAnnotationHidden(props.annotation)
    ? props.annotation.hideUntil
    : undefined;
  const reveal = props.annotation.reveal;
  const bodySummary = threadAnnotationAuthoredBody(props.annotation)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "");
  return {
    title: trigger ? resolve(msg("HIDDEN:")) : resolve(msg("NOTE:")),
    description:
      props.expanded && (trigger || reveal) ? undefined : trigger ? (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-foreground/80">
            <ThreadAnnotationHideSummary trigger={trigger} threadRef={props.threadRef} />
          </span>
          {bodySummary ? (
            <>
              <ComposerBanner.Separator />
              <span className="min-w-0 truncate text-foreground/60">{bodySummary}</span>
            </>
          ) : null}
        </span>
      ) : reveal ? (
        <span className="min-w-0 truncate text-foreground/80">
          <ThreadAnnotationRevealSummary reveal={reveal} threadRef={props.threadRef} />
        </span>
      ) : props.expanded ? (
        <ThreadAnnotationTimestamp annotation={props.annotation} />
      ) : (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-foreground/80">
            {bodySummary ?? resolve(msg("Annotation"))}
          </span>
          <ComposerBanner.Separator />
          <span className="shrink-0">
            <ThreadAnnotationTimestamp annotation={props.annotation} />
          </span>
        </span>
      ),
    children: props.expanded ? (
      <ComposerBanner.Body className="pe-1 pb-1">
        <ComposerBanner.Scroll className="max-h-48">
          <ThreadAnnotationBody
            annotation={props.annotation}
            cwd={props.cwd}
            onBodyChange={props.onBodyChange}
            showTimestamp={false}
            threadRef={props.threadRef}
          />
        </ComposerBanner.Scroll>
      </ComposerBanner.Body>
    ) : undefined,
  };
}

export function ThreadAnnotationActions(props: {
  annotation: ThreadAnnotationModel;
  onEdit: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onShowNow?: (() => void) | undefined;
  pending?: boolean | undefined;
  /** A different note is active, so a resolved note cannot reopen. Never affects Resolve. */
  reopenBlocked?: boolean | undefined;
  expanded?: boolean | undefined;
  onToggleExpanded?: (() => void) | undefined;
  trailing?: ReactNode;
}) {
  const gt = useGT();
  const reopenBlockedReasonId = useId();
  const reopenBlocked = props.reopenBlocked === true && Boolean(props.annotation.resolvedAt);
  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <button
          className="font-medium text-warning-foreground underline-offset-2 hover:underline disabled:opacity-50"
          disabled={props.pending}
          type="button"
          onClick={props.onEdit}
        >
          <T>Edit</T>
        </button>
        {props.onShowNow && isThreadAnnotationHidden(props.annotation) ? (
          <button
            className="font-medium text-warning-foreground underline-offset-2 hover:underline disabled:opacity-50"
            disabled={props.pending}
            type="button"
            onClick={props.onShowNow}
          >
            <T>Show now</T>
          </button>
        ) : null}
        <button
          aria-describedby={reopenBlocked ? reopenBlockedReasonId : undefined}
          className="font-medium text-warning-foreground underline-offset-2 hover:underline disabled:opacity-50 disabled:hover:no-underline"
          disabled={props.pending || reopenBlocked}
          type="button"
          onClick={props.annotation.resolvedAt ? props.onReopen : props.onResolve}
        >
          {props.annotation.resolvedAt
            ? gt("Reopen", { $context: "reopen the annotation" })
            : gt("Resolve", { $context: "resolve the annotation" })}
        </button>
        {props.onToggleExpanded ? (
          <Button
            aria-expanded={props.expanded === true}
            aria-label={props.expanded ? gt("Collapse annotation") : gt("Expand annotation")}
            disabled={props.pending}
            size="icon-xs"
            type="button"
            variant="ghost-warning"
            onClick={props.onToggleExpanded}
          >
            <ChevronDownIcon className={props.expanded ? "size-3.5" : "size-3.5 -rotate-90"} />
          </Button>
        ) : null}
        {props.trailing}
      </div>
      {reopenBlocked ? (
        <p className="mt-1.5 text-2xs text-warning-foreground" id={reopenBlockedReasonId}>
          <T>Resolve the current annotation to reopen this one, or copy what you need into it.</T>
        </p>
      ) : null}
    </>
  );
}

/** Adds native hover handling to a navigation row that already owns keyboard activation. */
export function ThreadAnnotationNavigationTrigger({
  annotationActive = true,
  ...props
}: ComponentProps<typeof PopoverTrigger> & { annotationActive?: boolean }) {
  return (
    <PopoverTrigger
      {...props}
      delay={0}
      nativeButton={false}
      openOnHover={annotationActive}
      aria-haspopup={undefined}
      aria-expanded={undefined}
      aria-controls={undefined}
      onFocusCapture={(event) => {
        props.onFocusCapture?.(event);
        // Only keyboard focus on the row opens its card; nested controls retain their trigger.
        if (
          annotationActive &&
          props.id &&
          event.target === event.currentTarget &&
          event.target.matches(":focus-visible")
        ) {
          props.handle?.open(props.id);
        }
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.key === "Enter" || event.key === " ") event.preventBaseUIHandler();
      }}
      onKeyUp={(event) => {
        props.onKeyUp?.(event);
        if (event.key === "Enter" || event.key === " ") event.preventBaseUIHandler();
      }}
    />
  );
}

export function ThreadAnnotationHoverPopover(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  handle: ReturnType<typeof PopoverCreateHandle>;
  navigationTriggerId: string;
  threadDetails: ReactNode;
  trailingContent?: ReactNode;
  readOnly?: boolean;
  onEdit: () => void;
  onResolve: () => void;
  onShowNow?: (() => void) | undefined;
  onBodyChange: (body: string) => Promise<boolean>;
}) {
  const bodyChangePending = useThreadAnnotationBodyPending(props.threadRef);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const openedByHover = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the detached popover handle and its imperative mounted content when the annotation row unmounts
  useEffect(() => {
    // The detached row outlives annotations removed or resolved by another client.
    const actions = actionsRef.current;
    return () => {
      props.handle.close();
      actions?.unmount();
    };
  }, [props.handle]);
  return (
    <Popover
      actionsRef={actionsRef}
      handle={props.handle}
      onOpenChange={(open, details) => {
        // The detached trigger is the navigation row. Clicking it must not pin the hover card.
        if (
          details.reason === "trigger-press" &&
          details.trigger?.id === props.navigationTriggerId
        ) {
          details.cancel();
        }
        const navigationTrigger = document.getElementById(props.navigationTriggerId);
        const activeElement = document.activeElement;
        if (
          !open &&
          details.reason === "trigger-hover" &&
          activeElement !== popupRef.current &&
          activeElement?.matches(":focus-visible") &&
          (popupRef.current?.contains(activeElement) || navigationTrigger?.contains(activeElement))
        ) {
          details.cancel();
        }
        if (!details.isCanceled) openedByHover.current = open && details.reason === "trigger-hover";
      }}
    >
      <PopoverPopup
        ref={popupRef}
        align="start"
        animated={false}
        className="max-w-80 text-left whitespace-normal before:hidden"
        elevated
        finalFocus={false}
        initialFocus={false}
        side="right"
        tooltipStyle
        padding="none"
        onFocusCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          // Keyboard interaction needs the popover's focus-out/Escape handling, unlike hover.
          if (
            openedByHover.current &&
            event.target !== event.currentTarget &&
            event.target.matches(":focus-visible")
          ) {
            props.handle.open(props.navigationTriggerId);
          }
        }}
        onBlurCapture={(event) => {
          const nextFocus = event.relatedTarget as Node | null;
          const navigationTrigger = document.getElementById(props.navigationTriggerId);
          // Base UI's hidden focus guards finish tab navigation and dismissal themselves.
          if (nextFocus instanceof Element && nextFocus.getAttribute("aria-hidden") === "true") {
            return;
          }
          if (event.currentTarget.contains(nextFocus) || navigationTrigger?.contains(nextFocus)) {
            return;
          }
          // A focused card remains visible only while its row or popup is still hovered.
          if (event.currentTarget.matches(":hover") || navigationTrigger?.matches(":hover")) return;
          props.handle.close();
        }}
      >
        <div className="flex min-h-0 min-w-0 w-80 max-h-(--available-height) max-w-80 flex-col">
          <div className="flex min-h-0 flex-col">{props.threadDetails}</div>
          <div className="flex min-h-0 max-h-[calc(var(--available-height)/3)] flex-col border-t border-border/70 bg-warning/10 p-(--floating-content-inset) text-warning-foreground">
            <ThreadAnnotationBody
              annotation={props.annotation}
              className="min-h-0 max-h-64 overflow-y-auto overscroll-contain"
              compact
              cwd={props.cwd}
              onBodyChange={props.readOnly ? undefined : props.onBodyChange}
              threadRef={props.threadRef}
            />
            {!props.readOnly ? (
              <div className="mt-2 shrink-0">
                <ThreadAnnotationActions
                  annotation={props.annotation}
                  onEdit={() => {
                    props.handle.close();
                    props.onEdit();
                  }}
                  onReopen={() => undefined}
                  onResolve={() => {
                    props.handle.close();
                    props.onResolve();
                  }}
                  onShowNow={props.onShowNow}
                  pending={bodyChangePending}
                />
              </div>
            ) : null}
          </div>
          {props.trailingContent}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
