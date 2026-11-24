import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { getSidebarThreadIdsToPrewarm } from "../Sidebar.logic";
import type { indexLastCodeSidebarThreads } from "./lastcodeSidebarProjects";
import { useLastCodeSidebarRoute } from "./useLastCodeSidebarRoute";
import { useLastCodeSidebarOrder } from "./useLastCodeSidebarOrder";
import { useLastCodeSidebarShortcuts } from "./useLastCodeSidebarShortcuts";
/** Compose route, family order and shortcuts with the existing three-thread prewarm cap. */
export function useLastCodeSidebarNavigation(
  projects: readonly SidebarProjectSnapshot[],
  index: ReturnType<typeof indexLastCodeSidebarThreads>,
  expandedLists: ReadonlySet<string>,
) {
  const route = useLastCodeSidebarRoute();
  const keys = useLastCodeSidebarOrder(
    projects,
    index.byProjectKey,
    route.routeThreadKey,
    expandedLists,
  );
  const shortcuts = useLastCodeSidebarShortcuts(keys, index.byThreadKey, route);
  const prewarmKeys = getSidebarThreadIdsToPrewarm(keys);
  const prewarmedSidebarThreadRefs = prewarmKeys.flatMap((key) => {
    const ref = parseScopedThreadKey(key);
    return ref ? [ref] : [];
  });
  return {
    routeThreadRef: route.routeThreadRef,
    routeThreadKey: route.routeThreadKey,
    prewarmedSidebarThreadRefs,
    ...shortcuts,
  };
}
