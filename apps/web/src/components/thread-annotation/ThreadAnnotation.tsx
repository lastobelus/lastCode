import {
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  type ScopedThreadRef,
  type ThreadAnnotation as ThreadAnnotationModel,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon } from "lucide-react";
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  // Keep the draft in the textarea so typing does not rerender the dialog and
  // its portal/focus-management subtree on every keystroke.
  const [canSave, setCanSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSaveRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!justOpened) return;
    const body = props.annotation?.body ?? "";
    if (textareaRef.current) textareaRef.current.value = body;
    const nextCanSave = body.trim().length > 0;
    canSaveRef.current = nextCanSave;
    setCanSave(nextCanSave);
    setSaving(false);
  }, [props.annotation?.body, props.open]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = textareaRef.current?.value.trim() ?? "";
    if (!trimmed || saving) return;
    setSaving(true);
    const saved = await props.onSave(trimmed);
    setSaving(false);
    if (saved) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.annotation ? "Edit annotation" : "Annotate thread"}</DialogTitle>
          <DialogDescription>
            Markdown supports headings, lists, task lists, links, and tags.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <Textarea
              ref={textareaRef}
              defaultValue={props.annotation?.body ?? ""}
              aria-label="Thread annotation"
              autoFocus
              className="[&_[data-slot=textarea]]:h-52 [&_[data-slot=textarea]]:field-sizing-fixed [&_[data-slot=textarea]]:resize-none"
              disabled={saving}
              maxLength={THREAD_ANNOTATION_MAX_BODY_CHARS}
              placeholder={"# Follow up\n\n- [ ] Next step\n- #tag"}
              variant="code"
              onChange={(event) => {
                const nextCanSave = event.target.value.trim().length > 0;
                if (nextCanSave === canSaveRef.current) return;
                canSaveRef.current = nextCanSave;
                setCanSave(nextCanSave);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave || saving} form={formId} type="submit">
            {saving ? "Saving…" : props.annotation ? "Save" : "Add annotation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadAnnotationTimestamp({ annotation }: { annotation: ThreadAnnotationModel }) {
  const timestamp = annotation.resolvedAt ?? annotation.updatedAt;
  return (
    <span className="text-2xs text-warning-foreground">
      {annotation.resolvedAt ? "Resolved" : "Edited"} {formatRelativeTimeLabel(timestamp)}
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

  const onTaskListChange = props.onBodyChange
    ? ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
        const nextBody = setMarkdownTaskChecked(props.annotation.body, markerOffset, checked);
        if (nextBody === props.annotation.body) return;
        void props.onBodyChange!(nextBody);
      }
    : undefined;

  return (
    <div className={props.className}>
      <ChatMarkdown
        className={props.compact ? "thread-annotation-compact" : "text-sm text-warning-foreground"}
        cwd={props.cwd}
        onTaskListChange={onTaskListChange}
        parseRawHtml={false}
        taskListDisabled={bodyChangePending}
        text={props.annotation.body}
        threadRef={props.threadRef}
      />
      {props.showTimestamp !== false ? (
        <ThreadAnnotationTimestamp annotation={props.annotation} />
      ) : null}
    </div>
  );
}

export function threadAnnotationBannerPresentation(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  expanded: boolean;
  onBodyChange?: ((body: string) => Promise<boolean>) | undefined;
}): Pick<ComposerBannerStackItem, "title" | "description" | "children"> {
  const summary =
    props.annotation.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^#{1,6}\s+/, "") ?? "Annotation";
  return {
    title: "NOTE:",
    description: props.expanded ? (
      <ThreadAnnotationTimestamp annotation={props.annotation} />
    ) : (
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate text-foreground/80">{summary}</span>
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
  pending?: boolean | undefined;
  expanded?: boolean | undefined;
  onToggleExpanded?: (() => void) | undefined;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <button
        className="font-medium text-warning-foreground underline-offset-2 hover:underline disabled:opacity-50"
        disabled={props.pending}
        type="button"
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        className="font-medium text-warning-foreground underline-offset-2 hover:underline disabled:opacity-50"
        disabled={props.pending}
        type="button"
        onClick={props.annotation.resolvedAt ? props.onReopen : props.onResolve}
      >
        {props.annotation.resolvedAt ? "Reopen" : "Resolve"}
      </button>
      {props.onToggleExpanded ? (
        <Button
          aria-expanded={props.expanded === true}
          aria-label={props.expanded ? "Collapse annotation" : "Expand annotation"}
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
        // Pointer focus must not pin the card when clicking the already-active thread.
        if (
          annotationActive &&
          props.id &&
          event.currentTarget.contains(event.target) &&
          event.target.getAttribute("aria-hidden") !== "true" &&
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
  onEdit: () => void;
  onResolve: () => void;
  onBodyChange: (body: string) => Promise<boolean>;
}) {
  const bodyChangePending = useThreadAnnotationBodyPending(props.threadRef);
  const popupRef = useRef<HTMLDivElement | null>(null);
  return (
    <Popover
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
          (popupRef.current?.contains(activeElement) ||
            (navigationTrigger?.contains(activeElement) &&
              activeElement?.matches(":focus-visible")))
        ) {
          details.cancel();
        }
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
          props.handle.open(props.navigationTriggerId);
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
        <div className="flex min-w-0 w-80 max-w-80 flex-col">
          {props.threadDetails}
          <div className="border-t border-border/70 bg-warning/10 p-(--floating-content-inset) text-warning-foreground">
            <ThreadAnnotationBody
              annotation={props.annotation}
              className="max-h-64 overflow-y-auto"
              compact
              cwd={props.cwd}
              onBodyChange={props.onBodyChange}
              threadRef={props.threadRef}
            />
            <div className="mt-2">
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
                pending={bodyChangePending}
              />
            </div>
          </div>
          {props.trailingContent}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
