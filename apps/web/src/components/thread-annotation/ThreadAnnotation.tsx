import {
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  type ScopedThreadRef,
  type ThreadAnnotation as ThreadAnnotationModel,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

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
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!justOpened) return;
    setBody(props.annotation?.body ?? "");
    setSaving(false);
  }, [props.annotation?.body, props.open]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const saved = await props.onSave(trimmed);
    setSaving(false);
    if (saved) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{props.annotation ? "Edit annotation" : "Annotate thread"}</DialogTitle>
            <DialogDescription>
              Markdown supports headings, lists, task lists, links, and tags.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel scrollFade={false}>
            <Textarea
              ref={textareaRef}
              aria-label="Thread annotation"
              autoFocus
              className="[&_[data-slot=textarea]]:min-h-52 [&_[data-slot=textarea]]:font-mono [&_[data-slot=textarea]]:text-sm"
              disabled={saving}
              maxLength={THREAD_ANNOTATION_MAX_BODY_CHARS}
              placeholder={"# Follow up\n\n- [ ] Next step\n- #tag"}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!body.trim() || saving} type="submit">
              {saving ? "Saving…" : props.annotation ? "Save" : "Add annotation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function AnnotationTimestamp({ annotation }: { annotation: ThreadAnnotationModel }) {
  const timestamp = annotation.resolvedAt ?? annotation.updatedAt;
  return (
    <span className="text-[11px] text-accent-foreground/55">
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
        className={props.compact ? "thread-annotation-compact" : "text-sm text-accent-foreground"}
        cwd={props.cwd}
        onTaskListChange={onTaskListChange}
        parseRawHtml={false}
        taskListDisabled={bodyChangePending}
        text={props.annotation.body}
        threadRef={props.threadRef}
      />
      <AnnotationTimestamp annotation={props.annotation} />
    </div>
  );
}

export function ThreadAnnotationActions(props: {
  annotation: ThreadAnnotationModel;
  onEdit: () => void;
  onResolve: () => void;
  onReopen: () => void;
  pending?: boolean | undefined;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <button
        className="font-medium text-accent-foreground/75 underline-offset-2 hover:underline disabled:opacity-50"
        disabled={props.pending}
        type="button"
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        className="font-medium text-accent-foreground/75 underline-offset-2 hover:underline disabled:opacity-50"
        disabled={props.pending}
        type="button"
        onClick={props.annotation.resolvedAt ? props.onReopen : props.onResolve}
      >
        {props.annotation.resolvedAt ? "Reopen" : "Resolve"}
      </button>
      {props.trailing}
    </div>
  );
}

export function ThreadAnnotationPostIt(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  onDismiss: () => void;
  onEdit: () => void;
  onResolve: () => void;
  onBodyChange: (body: string) => Promise<boolean>;
  pending?: boolean | undefined;
}) {
  const bodyChangePending = useThreadAnnotationBodyPending(props.threadRef);
  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl rounded-xl border border-border/80 bg-accent px-3.5 py-2.5 text-accent-foreground shadow-sm">
      <ThreadAnnotationBody
        annotation={props.annotation}
        className="max-h-48 overflow-y-auto"
        cwd={props.cwd}
        onBodyChange={props.onBodyChange}
        threadRef={props.threadRef}
      />
      <div className="mt-2 flex items-center justify-between">
        <ThreadAnnotationActions
          annotation={props.annotation}
          onEdit={props.onEdit}
          onReopen={() => undefined}
          onResolve={props.onResolve}
          pending={props.pending || bodyChangePending}
        />
        <button
          className="text-xs text-accent-foreground/55 hover:text-accent-foreground"
          type="button"
          onClick={props.onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function ThreadAnnotationHoverPopover(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  rowActive: boolean;
  trigger: ReactNode;
  threadDetails: ReactNode;
  onEdit: () => void;
  onResolve: () => void;
  onBodyChange: (body: string) => Promise<boolean>;
}) {
  const bodyChangePending = useThreadAnnotationBodyPending(props.threadRef);
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const openRef = useRef(false);
  const rowActiveRef = useRef(props.rowActive);
  const popupHoveredRef = useRef(false);
  const popupFocusedRef = useRef(false);
  const setPopoverOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      popupHoveredRef.current = false;
      popupFocusedRef.current = false;
    }
    openRef.current = nextOpen;
    setOpen(nextOpen);
  }, []);
  const keepOpen = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setPopoverOpen(true);
  }, [setPopoverOpen]);
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (rowActiveRef.current || popupHoveredRef.current || popupFocusedRef.current) return;
      setPopoverOpen(false);
    }, 120);
  }, [setPopoverOpen]);

  useEffect(() => {
    rowActiveRef.current = props.rowActive;
    if (props.rowActive) {
      keepOpen();
    } else {
      scheduleClose();
    }
  }, [keepOpen, props.rowActive, scheduleClose]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return (
    <Popover open={open} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="max-w-80 text-left whitespace-normal shadow-xl shadow-black/25 before:hidden"
        finalFocus={false}
        initialFocus={false}
        side="right"
        tooltipStyle
        viewportClassName="p-0"
        onMouseEnter={() => {
          if (!openRef.current && !rowActiveRef.current) return;
          popupHoveredRef.current = true;
          keepOpen();
        }}
        onMouseLeave={() => {
          popupHoveredRef.current = false;
          scheduleClose();
        }}
        onFocusCapture={() => {
          popupFocusedRef.current = true;
          keepOpen();
        }}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          popupFocusedRef.current = false;
          scheduleClose();
        }}
      >
        <div className="flex min-w-0 w-80 max-w-80 flex-col">
          {props.threadDetails}
          <div className="border-t border-border/70 bg-accent p-[var(--floating-content-inset)] text-accent-foreground">
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
                  setPopoverOpen(false);
                  props.onEdit();
                }}
                onReopen={() => undefined}
                onResolve={() => {
                  setPopoverOpen(false);
                  props.onResolve();
                }}
                pending={bodyChangePending}
              />
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
