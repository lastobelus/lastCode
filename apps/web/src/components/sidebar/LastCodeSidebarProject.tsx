import { LastCodeProjectRenameDialog } from "./LastCodeProjectRenameDialog";
import { LastCodeProjectGroupingDialog } from "./LastCodeProjectGroupingDialog";
import { memo, useCallback, useMemo } from "react";
import { useClientSetting } from "../../hooks/useSettings";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { LastCodeProjectHeader, type LastCodeProjectDragHandle } from "./LastCodeProjectHeader";
import {
  lastCodeProjectExpansionPreferenceKeys,
  type LastCodeProjectDragGestures,
} from "./useLastCodeProjectHeaderGestures";
import { useLastCodeProjectEnvironmentIcons } from "./useLastCodeProjectEnvironmentIcons";
import { useLastCodeProjectThreads } from "./useLastCodeProjectThreads";
import { useLastCodeThreadEditing } from "./useLastCodeThreadEditing";
import { useLastCodeThreadAnnotations } from "./useLastCodeThreadAnnotations";
import { useLastCodeThreadNavigation } from "./useLastCodeThreadNavigation";
import { useLastCodeProjectMenus } from "./useLastCodeProjectMenus";
import { useLastCodeThreadRowRenderer } from "./LastCodeThreadRow";
import { LastCodeProjectNewThread } from "./LastCodeProjectNewThread";
import { LastCodeThreadList } from "./LastCodeThreadList";
interface Props {
  project: SidebarProjectSnapshot;
  activeThreadKey: string | null;
  listExpanded: boolean;
  onListExpandedChange: (projectKey: string, expanded: boolean) => void;
  jumpLabels: ReadonlyMap<string, string>;
  dragHandle: LastCodeProjectDragHandle | null;
  gestures: LastCodeProjectDragGestures;
  newThread: { handle: ReturnType<typeof useNewThreadHandler>; shortcutLabel: string | null };
}
/** Compose one logical project's focused projection, menus, editors and keyed family list. */
export const LastCodeSidebarProject = memo(function LastCodeSidebarProject(props: Props) {
  const { project, activeThreadKey, listExpanded, newThread } = props;
  const scale = useClientSetting("legacySidebarScale");
  const environments = useLastCodeProjectEnvironmentIcons(project);
  const preferenceKeys = useMemo(() => lastCodeProjectExpansionPreferenceKeys(project), [project]);
  const expanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, preferenceKeys),
  );
  const { threadsByKey, projectStatus, hiddenThreadStatus, familyProjection } =
    useLastCodeProjectThreads(project, activeThreadKey, expanded, listExpanded);
  const editing = useLastCodeThreadEditing();
  const annotations = useLastCodeThreadAnnotations();
  const navigation = useLastCodeThreadNavigation(familyProjection.orderedThreadKeys);
  const projection = useMemo(
    () => ({ familyProjection, hiddenThreadStatus }),
    [familyProjection, hiddenThreadStatus],
  );
  const { showProjectMenu, menus, renameDialog, groupingDialog } = useLastCodeProjectMenus(
    project,
    threadsByKey,
    editing.capabilities,
    annotations.actions,
    navigation.navigateToThread,
    newThread.handle,
  );
  const renderRow = useLastCodeThreadRowRenderer(
    project.workspaceRoot,
    activeThreadKey,
    props.jumpLabels,
    editing,
    navigation,
    menus,
    annotations.actions,
  );
  const { onListExpandedChange } = props;
  const onExpandedChange = useCallback(
    (value: boolean) => onListExpandedChange(project.projectKey, value),
    [onListExpandedChange, project.projectKey],
  );
  return (
    <>
      <LastCodeProjectHeader
        project={project}
        expanded={expanded}
        status={projectStatus}
        environments={environments}
        drag={{ manual: props.dragHandle !== null, handle: props.dragHandle }}
        gestures={props.gestures}
        showMenu={showProjectMenu}
      >
        <LastCodeProjectNewThread
          project={project}
          handleNewThread={newThread.handle}
          shortcutLabel={newThread.shortcutLabel}
        />
      </LastCodeProjectHeader>
      <LastCodeThreadList
        scale={scale}
        projectExpanded={expanded}
        projection={projection}
        listExpanded={listExpanded}
        onListExpandedChange={onExpandedChange}
        navigateToThread={navigation.navigateToThread}
        renderRow={renderRow}
      />
      {annotations.editor}
      <LastCodeProjectRenameDialog {...renameDialog} />
      <LastCodeProjectGroupingDialog {...groupingDialog} />
    </>
  );
});
