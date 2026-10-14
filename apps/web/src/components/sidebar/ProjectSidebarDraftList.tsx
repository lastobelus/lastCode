import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { readLocalApi } from "../../localApi";
import { useProjects } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { SidebarDraftBlock } from "../Sidebar";
import { buildDraftActionMenuItems } from "../threadActionMenu.logic";
import { SidebarMenu, useSidebar } from "../ui/sidebar";

// Keep invested drafts reachable on either project-tree sidebar. Its own
// subscriptions isolate composer updates from the project list.
export function ProjectSidebarDraftList() {
  const projects = useProjects();
  const { copyToClipboard } = useCopyToClipboard({ target: "draft details" });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // The legacy list has no grouped display names on draft rows; the
  // project's own title is what its header shows for local projects.
  const projectTitleByKey = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, navigate, setOpenMobile],
  );
  const handleDraftContextMenu = useCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: false,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "copy-path":
            if (workspacePath) copyToClipboard(workspacePath);
            return;
          case "copy-branch":
            if (session.branch) copyToClipboard(session.branch);
            return;
          case "discard": {
            // Sending can promote the draft while its menu is open.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
    [copyToClipboard, projectByKey],
  );
  return (
    <SidebarMenu>
      <SidebarDraftBlock
        projectByKey={projectByKey}
        projectDisplayNameByKey={projectTitleByKey}
        scopedProjectKeys={null}
        routeDraftId={routeDraftId}
        onNavigateToDraft={navigateToDraft}
        onDraftContextMenu={handleDraftContextMenu}
      />
    </SidebarMenu>
  );
}
