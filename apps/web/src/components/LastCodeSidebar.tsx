import { LastCodeSidebarContent } from "./sidebar/LastCodeSidebarContent";
import { LastCodeThreadActionsProvider } from "./sidebar/LastCodeThreadActions";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { isElectron } from "../env";

/** The lazy LastCode entry owns chrome and the single thread-operation provider. */
export default function LastCodeSidebar() {
  return (
    <LastCodeThreadActionsProvider>
      <SidebarChromeHeader isElectron={isElectron} />
      <LastCodeSidebarContent />
      <SidebarChromeFooter />
    </LastCodeThreadActionsProvider>
  );
}
