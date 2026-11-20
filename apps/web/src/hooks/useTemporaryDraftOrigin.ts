import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import type { DraftId } from "../composerDraftStore";
import { useProject } from "../state/entities";
import { useStableCallback } from "./useStableCallback";

function matches(project: EnvironmentProject | null, ref: ScopedProjectRef) {
  return project?.id === ref.projectId && project.environmentId === ref.environmentId;
}

/** A machine switch can return to the original temporary checkout within the same draft. */
export function useTemporaryDraftOrigin(
  draftId: DraftId | null,
  activeProject: EnvironmentProject | null,
) {
  const [retained, setRetained] = useState<{
    draftId: DraftId;
    origin: ScopedProjectRef;
    from: ScopedProjectRef;
    target: ScopedProjectRef;
  } | null>(null);
  const atTarget = retained !== null && matches(activeProject, retained.target);
  const valid =
    retained !== null &&
    retained.draftId === draftId &&
    (atTarget || matches(activeProject, retained.from));

  if (retained !== null && !valid) setRetained(null);
  if (valid && atTarget && retained.from !== retained.target)
    setRetained({ ...retained, from: retained.target });

  const origin = useProject(valid ? retained.origin : null);
  const rememberRetarget = useStableCallback((target: ScopedProjectRef) => {
    if (draftId === null || activeProject === null) return;
    const from = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const originRef = activeProject.temporary === true ? from : valid ? retained.origin : null;
    if (originRef !== null) setRetained({ draftId, origin: originRef, from, target });
  });
  return { origin, rememberRetarget };
}
