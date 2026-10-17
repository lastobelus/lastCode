import { useCallback, useMemo, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  const saveAnnotationBody = useCallback(
    async (target: SidebarThreadSummary, body: string): Promise<boolean> => {
      return runThreadAnnotationBodySave(
        scopeThreadRef(target.environmentId, target.id),
        async () => {
          const result = await upsertThreadAnnotation({
            environmentId: target.environmentId,
            input: { threadId: target.id, body },
          });
          if (result._tag === "Success") return true;
          reportThreadOperationFailure(result, "Failed to save annotation");
          return false;
        },
      );
    },
    [upsertThreadAnnotation],
  );

  const saveAnnotation = useCallback(
    async (body: string): Promise<boolean> => {
      if (!annotationEditorTarget) return false;
      return saveAnnotationBody(annotationEditorTarget, body);
    },
    [annotationEditorTarget, saveAnnotationBody],
  );

  const resolveAnnotation = useCallback(
    async (thread: SidebarThreadSummary) => {
      const result = await resolveThreadAnnotation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      reportThreadOperationFailure(result, "Failed to resolve annotation");
    },
    [resolveThreadAnnotation],
  );

  const actions = useMemo(
    () => ({
      onEditAnnotation: setAnnotationEditorTarget,
      onSaveAnnotationBody: saveAnnotationBody,
      onResolveAnnotation: (thread: SidebarThreadSummary) => void resolveAnnotation(thread),
    }),
    [saveAnnotationBody, resolveAnnotation],
  );
  return {
    actions,
    editor: (
      <ThreadAnnotationEditorDialog
        annotation={annotationEditorTarget?.annotation ?? null}
        open={annotationEditorTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAnnotationEditorTarget(null);
        }}
        onSave={saveAnnotation}
      />
    ),
  };
}
