import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, StickyNoteIcon } from "lucide-react";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useUiStateStore } from "../../uiStateStore";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  runThreadAnnotationBodySave,
  threadAnnotationBannerPresentation,
  ThreadAnnotationActions,
  ThreadAnnotationEditorDialog,
  useThreadAnnotationBodyPending,
} from "./ThreadAnnotation";
import {
  parseThreadAnnotationSubmission,
  saveThreadAnnotationSubmission,
} from "./threadAnnotationSubmission";

function reportAnnotationFailure(action: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `Failed to ${action} annotation`,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function useAnnotationMutations(
  threadRef: ScopedThreadRef | null,
  canAnnotate: boolean,
  routeKey: string,
) {
  const upsert = useOrchestrationCommand(threadEnvironment.upsertAnnotation, {
    reportFailure: false,
  });
  const resolve = useOrchestrationCommand(threadEnvironment.resolveAnnotation, {
    reportFailure: false,
  });
  const reopen = useOrchestrationCommand(threadEnvironment.reopenAnnotation, {
    reportFailure: false,
  });
  const [resolution, setResolution] = useState<{ key: string } | null>(null);
  const bodyPending = useThreadAnnotationBodyPending(threadRef);
  const save = async (body: string): Promise<boolean> => {
    if (threadRef === null || !canAnnotate) return false;
    return runThreadAnnotationBodySave(threadRef, async () => {
      const result = await upsert({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, body },
      });
      reportAnnotationFailure("save", result);
      return result._tag === "Success";
    });
  };
  const changeResolution = async (next: "resolve" | "reopen") => {
    if (threadRef === null || !canAnnotate) return;
    const operation = { key: routeKey };
    setResolution(operation);
    const command = next === "resolve" ? resolve : reopen;
    await (async () => {
      const result = await command({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      reportAnnotationFailure(next, result);
    })().finally(() => setResolution((current) => (current === operation ? null : current)));
  };
  return { save, changeResolution, pending: bodyPending || resolution?.key === routeKey };
}

function useAnnotationBanner(input: {
  routeThreadRef: ScopedThreadRef;
  annotation: ThreadAnnotation | null;
  canOperate: boolean;
  canAnnotate: boolean;
  cwd: string | null;
  pending: boolean;
  onEdit: () => void;
  onSave: (body: string) => Promise<boolean>;
  onResolve: () => void;
}) {
  const {
    routeThreadRef,
    annotation,
    canOperate,
    canAnnotate,
    cwd,
    pending,
    onEdit,
    onSave,
    onResolve,
  } = input;
  const key = scopedThreadKey(routeThreadRef);
  const expanded = useUiStateStore((store) => store.threadAnnotationExpandedById[key] === true);
  const setExpanded = useUiStateStore((store) => store.setThreadAnnotationExpanded);
  const [dismissal, setDismissal] = useState<{ route: string; version: string | null }>({
    route: key,
    version: null,
  });
  if (dismissal.route !== key) setDismissal({ route: key, version: null });
  if (annotation?.resolvedAt !== null) return null;
  const version = `${key}:${annotation.updatedAt}`;
  if (dismissal.version === version) return null;
  const toggleExpanded = () => setExpanded(key, !expanded);
  const banner: ComposerBannerStackItem = {
    id: `thread-annotation:${version}`,
    variant: "warning",
    icon: <StickyNoteIcon aria-hidden className="size-3.5" />,
    ...threadAnnotationBannerPresentation({
      annotation,
      cwd: cwd ?? undefined,
      expanded,
      onBodyChange: canAnnotate ? onSave : undefined,
      threadRef: routeThreadRef,
    }),
    actions: canOperate ? (
      <ThreadAnnotationActions
        annotation={annotation}
        onEdit={onEdit}
        onReopen={() => undefined}
        onResolve={onResolve}
        expanded={expanded}
        onToggleExpanded={toggleExpanded}
        pending={pending}
      />
    ) : (
      <Button
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse annotation" : "Expand annotation"}
        size="icon-xs"
        variant="ghost-warning"
        onClick={toggleExpanded}
      >
        <ChevronDownIcon className={expanded ? "size-3.5" : "size-3.5 -rotate-90"} />
      </Button>
    ),
    dismissLabel: "Dismiss thread annotation",
    onDismiss: () => setDismissal({ route: key, version }),
  };
  return banner;
}

export function useChatThreadAnnotation(input: {
  routeThreadRef: ScopedThreadRef;
  threadRef: ScopedThreadRef | null;
  annotation: ThreadAnnotation | null;
  supported: boolean;
  hasUserMessage: () => boolean;
  cwd: string | null;
}) {
  const { routeThreadRef, threadRef, annotation, supported, hasUserMessage, cwd } = input;
  const routeKey = scopedThreadKey(routeThreadRef);
  const canOperate = useEnvironmentScope(
    routeThreadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const canAnnotate =
    canOperate && threadRef !== null && supported && (annotation !== null || hasUserMessage());
  const mutations = useAnnotationMutations(threadRef, canAnnotate, routeKey);
  const [editor, setEditor] = useState<{ route: string } | null>(null);
  if (editor !== null && editor.route !== routeKey) setEditor(null);
  const openEditor = () => setEditor({ route: routeKey });
  const onOpenChange = (open: boolean) => {
    if (open) openEditor();
    else setEditor((current) => (current === editor ? null : current));
  };
  const onResolve = () => void mutations.changeResolution("resolve");
  const banner = useAnnotationBanner({
    routeThreadRef,
    annotation,
    canOperate,
    canAnnotate,
    cwd,
    pending: mutations.pending,
    onEdit: openEditor,
    onSave: mutations.save,
    onResolve,
  });

  const interceptSubmission = (submission: {
    target: ComposerThreadTarget;
    prompt: string;
    directAnnotation: boolean;
    onDraftConsumed: () => void;
  }): boolean | Promise<boolean> => {
    if (submission.directAnnotation) return false;
    const draft = useComposerDraftStore.getState().getComposerDraft(submission.target);
    const command = parseThreadAnnotationSubmission(submission.prompt, draft);
    if (command === null) return false;
    if (!canAnnotate) {
      const unavailable = threadRef !== null && !supported;
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: unavailable ? "Annotations unavailable" : "Send a message first",
          description: unavailable
            ? "This environment needs a newer LastCode server to annotate threads."
            : "Annotations can be added after the thread has its first message.",
        }),
      );
      return true;
    }
    if (command.kind === "open-editor") {
      useComposerDraftStore.getState().clearComposerContent(submission.target);
      submission.onDraftConsumed();
      openEditor();
      return true;
    }
    return saveThreadAnnotationSubmission({
      target: submission.target,
      draft,
      save: () => mutations.save(command.body),
      onDraftConsumed: submission.onDraftConsumed,
    }).then(() => true);
  };
  return {
    canAnnotate,
    openEditor,
    interceptSubmission,
    banner,
    editor: (
      <ThreadAnnotationEditorDialog
        key={routeKey}
        annotation={annotation}
        open={editor !== null && editor.route === routeKey && canAnnotate}
        onOpenChange={onOpenChange}
        onSave={mutations.save}
      />
    ),
    timeline: {
      annotation,
      ...(canAnnotate
        ? {
            onAnnotationBodyChange: mutations.save,
            onAnnotationEdit: openEditor,
            onAnnotationResolve: onResolve,
            onAnnotationReopen: () => void mutations.changeResolution("reopen"),
          }
        : {}),
    },
  };
}
