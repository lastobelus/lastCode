import {
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  type ScopedThreadRef,
  type ThreadAnnotation as ThreadAnnotationModel,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
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

export function ThreadAnnotationEditorDialog(props: {
  annotation: ThreadAnnotationModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
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
    <span className="text-[11px] text-yellow-900/55 dark:text-yellow-100/55">
      {annotation.resolvedAt ? "Resolved" : "Edited"} {formatRelativeTimeLabel(timestamp)}
    </span>
  );
}

export function ThreadAnnotationBody(props: {
  annotation: ThreadAnnotationModel;
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
  className?: string;
}) {
  return (
    <div className={props.className}>
      <ChatMarkdown
        className="text-sm text-yellow-950 dark:text-yellow-50"
        cwd={props.cwd}
        parseRawHtml={false}
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
        className="font-medium text-yellow-950/75 underline-offset-2 hover:underline disabled:opacity-50 dark:text-yellow-50/75"
        disabled={props.pending}
        type="button"
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        className="font-medium text-yellow-950/75 underline-offset-2 hover:underline disabled:opacity-50 dark:text-yellow-50/75"
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
  pending?: boolean | undefined;
}) {
  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl rounded-xl border border-yellow-300/70 bg-yellow-100/92 px-3.5 py-2.5 text-yellow-950 shadow-sm dark:border-yellow-700/50 dark:bg-yellow-950/72 dark:text-yellow-50">
      <ThreadAnnotationBody
        annotation={props.annotation}
        className="max-h-48 overflow-y-auto"
        cwd={props.cwd}
        threadRef={props.threadRef}
      />
      <div className="mt-2 flex items-center justify-between">
        <ThreadAnnotationActions
          annotation={props.annotation}
          onEdit={props.onEdit}
          onReopen={() => undefined}
          onResolve={props.onResolve}
          pending={props.pending}
        />
        <button
          className="text-xs text-yellow-950/55 hover:text-yellow-950 dark:text-yellow-50/55 dark:hover:text-yellow-50"
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
  onEdit: () => void;
  onResolve: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const keepOpen = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setOpen(true);
  }, []);
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  }, []);

  useEffect(() => {
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={keepOpen}
        onMouseLeave={scheduleClose}
        onFocus={keepOpen}
        onBlur={scheduleClose}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {props.trigger}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-80 border border-yellow-300/70 bg-yellow-100/95 dark:border-yellow-700/50 dark:bg-yellow-950/90"
        side="right"
        onMouseEnter={keepOpen}
        onMouseLeave={scheduleClose}
        onFocus={keepOpen}
        onBlur={scheduleClose}
      >
        <ThreadAnnotationBody
          annotation={props.annotation}
          className="max-h-64 overflow-y-auto"
          cwd={props.cwd}
          threadRef={props.threadRef}
        />
        <div className="mt-2">
          <ThreadAnnotationActions
            annotation={props.annotation}
            onEdit={() => {
              setOpen(false);
              props.onEdit();
            }}
            onReopen={() => undefined}
            onResolve={() => {
              setOpen(false);
              props.onResolve();
            }}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
