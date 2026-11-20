import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { DraftSessionState } from "./composerDraftStore";

export function temporaryDraftProjectRef(key: string | undefined) {
  return key === undefined ? null : parseScopedProjectKey(key);
}

export function draftOriginForEnvironmentChange(
  draft: DraftSessionState | null,
  projects: readonly EnvironmentProject[],
) {
  if (draft === null) return {};
  const origin = draft.temporaryProjectOriginKey;
  if (origin !== undefined) return { temporaryProjectOriginKey: origin };
  const project = projects.find(
    (project) => project.environmentId === draft.environmentId && project.id === draft.projectId,
  );
  return project?.temporary === true
    ? {
        temporaryProjectOriginKey: scopedProjectKey(
          scopeProjectRef(project.environmentId, project.id),
        ),
      }
    : {};
}
