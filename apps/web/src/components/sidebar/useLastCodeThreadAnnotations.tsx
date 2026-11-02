import { useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadAnnotationId } from "@t3tools/shared/threadAnnotation";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import type { SidebarThreadSummary } from "../../types";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import {
  runThreadAnnotationBodySave,
  ThreadAnnotationEditorDialog,
} from "../thread-annotation/ThreadAnnotation";

export function useLastCodeThreadAnnotations() {
  const upsertThreadAnnotation = useOrchestrationCommand(threadEnvironment.upsertAnnotation, {
    reportFailure: false,
  });
  const resolveThreadAnnotation = useOrchestrationCommand(threadEnvironment.resolveAnnotation, {
    reportFailure: false,
  });
  const [annotationEditorTarget, setAnnotationEditorTarget] = useState<SidebarThreadSummary | null>(
    null,
  );
  const saveAnnotationBody = async (
    target: SidebarThreadSummary,
    body: string,
    createNew = false,
  ): Promise<boolean> => {
    return runThreadAnnotationBodySave(
      scopeThreadRef(target.environmentId, target.id),
      async () => {
        const result = await upsertThreadAnnotation({
          environmentId: target.environmentId,
          input: {
            threadId: target.id,
            body,
            ...(createNew
              ? { createNew: true }
              : target.annotation
                ? { annotationId: threadAnnotationId(target.annotation) }
                : {}),
          },
        });
        if (result._tag === "Success") return true;
        reportThreadOperationFailure(result, "Failed to save annotation");
        return false;
      },
    );
  };

  const saveAnnotation = async (body: string): Promise<boolean> => {
    if (!annotationEditorTarget) return false;
    return saveAnnotationBody(
      annotationEditorTarget,
      body,
      annotationEditorTarget.annotation?.resolvedAt !== null,
    );
  };

  const resolveAnnotation = async (thread: SidebarThreadSummary) => {
    const result = await resolveThreadAnnotation({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(thread.annotation ? { annotationId: threadAnnotationId(thread.annotation) } : {}),
      },
    });
    reportThreadOperationFailure(result, "Failed to resolve annotation");
  };

  const actions = {
    onEditAnnotation: setAnnotationEditorTarget,
    onSaveAnnotationBody: saveAnnotationBody,
    onResolveAnnotation: (thread: SidebarThreadSummary) => void resolveAnnotation(thread),
  };
  return {
    actions,
    editor: (
      <ThreadAnnotationEditorDialog
        annotation={
          annotationEditorTarget?.annotation?.resolvedAt == null
            ? (annotationEditorTarget?.annotation ?? null)
            : null
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
