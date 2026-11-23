import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadAnnotationId } from "@t3tools/shared/threadAnnotation";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import type { SidebarThreadSummary } from "../../types";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { readEnvironmentSupportsThreadAnnotations, useServerConfigs } from "../../state/entities";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  runThreadAnnotationBodySave,
  ThreadAnnotationEditorDialog,
} from "../thread-annotation/ThreadAnnotation";

import {
  showThreadNow,
  type AnnotationEdit,
} from "../thread-annotation/threadAnnotationHideUntil.logic";

function checkAnnotationSupport(target: SidebarThreadSummary): boolean {
  if (readEnvironmentSupportsThreadAnnotations(target.environmentId)) return true;
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: m(msg("Annotations unavailable")),
      description: m(msg("This environment needs a newer LastCode server to annotate threads.")),
    }),
  );
  return false;
}

export function useLastCodeThreadAnnotations() {
  const upsertThreadAnnotation = useOrchestrationCommand(threadEnvironment.upsertAnnotation, {
    reportFailure: false,
  });
  const resolveThreadAnnotation = useOrchestrationCommand(threadEnvironment.resolveAnnotation, {
    reportFailure: false,
  });
  const configs = useServerConfigs();
  const [annotationEditorTarget, setAnnotationEditorTarget] = useState<SidebarThreadSummary | null>(
    null,
  );
  const saveAnnotationEdit = async (
    target: SidebarThreadSummary,
    edit: AnnotationEdit,
    createNew = false,
    failure: string = msg("Failed to save annotation"),
  ): Promise<boolean> => {
    if (!checkAnnotationSupport(target)) return false;
    return runThreadAnnotationBodySave(
      scopeThreadRef(target.environmentId, target.id),
      async () => {
        const result = await upsertThreadAnnotation({
          environmentId: target.environmentId,
          input: {
            threadId: target.id,
            ...edit,
            ...(createNew
              ? { createNew: true }
              : target.annotation
                ? { annotationId: threadAnnotationId(target.annotation) }
                : {}),
          },
        });
        if (result._tag === "Success") return true;
        reportThreadOperationFailure(result, failure);
        return false;
      },
    );
  };

  const saveAnnotation = async (edit: AnnotationEdit): Promise<boolean> => {
    if (!annotationEditorTarget) return false;
    return saveAnnotationEdit(
      annotationEditorTarget,
      edit,
      annotationEditorTarget.annotation?.resolvedAt !== null,
    );
  };

  const resolveAnnotation = async (thread: SidebarThreadSummary) => {
    if (!checkAnnotationSupport(thread)) return;
    const result = await resolveThreadAnnotation({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(thread.annotation ? { annotationId: threadAnnotationId(thread.annotation) } : {}),
      },
    });
    reportThreadOperationFailure(result, msg("Failed to resolve annotation"));
  };

  const supportsHideUntil = (thread: SidebarThreadSummary) =>
    configs.get(thread.environmentId)?.environment.capabilities.threadAnnotationHideUntil === true;
  const actions = {
    onEditAnnotation: (thread: SidebarThreadSummary) => {
      if (checkAnnotationSupport(thread)) setAnnotationEditorTarget(thread);
    },
    onSaveAnnotationBody: (thread: SidebarThreadSummary, body: string) =>
      saveAnnotationEdit(thread, supportsHideUntil(thread) ? { body, bodyEdited: true } : { body }),
    onShowAnnotationNow: (thread: SidebarThreadSummary) => {
      const trigger = thread.annotation?.hideUntil;
      if (trigger && supportsHideUntil(thread)) {
        void saveAnnotationEdit(
          thread,
          showThreadNow(trigger),
          false,
          msg("Failed to show thread"),
        );
      }
    },
    canShowAnnotationNow: supportsHideUntil,
    onResolveAnnotation: (thread: SidebarThreadSummary) => void resolveAnnotation(thread),
  };
  const editorEnvironment = annotationEditorTarget
    ? configs.get(annotationEditorTarget.environmentId)?.environment
    : undefined;
  return {
    actions,
    editor: (
      <ThreadAnnotationEditorDialog
        annotation={
          annotationEditorTarget?.annotation?.resolvedAt == null
            ? (annotationEditorTarget?.annotation ?? null)
            : null
        }
        hideUntil={
          annotationEditorTarget &&
          editorEnvironment?.capabilities.threadAnnotationHideUntil === true
            ? {
                serverVersion: editorEnvironment.serverVersion,
                threadRef: scopeThreadRef(
                  annotationEditorTarget.environmentId,
                  annotationEditorTarget.id,
                ),
              }
            : undefined
        }
        open={annotationEditorTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAnnotationEditorTarget(null);
        }}
        onSave={saveAnnotation}
      />
    ),
  };
}
