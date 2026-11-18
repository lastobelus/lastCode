import { memo } from "react";
import { SearchIcon } from "lucide-react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Kbd } from "../ui/kbd";
import { CommandDialogTrigger } from "../ui/command";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { LastCodeSidebarThreadPicker } from "./LastCodeSidebarThreadPicker";

export const LastCodeSidebarSearch = memo(function LastCodeSidebarSearch({
  projects,
  shortcutLabel,
}: {
  projects: readonly SidebarProjectSnapshot[];
  shortcutLabel: string | null;
}) {
  return (
    // Lifted above the stage backdrop, whose fade would paint across the search outline.
    <SidebarGroup className="z-[1]">
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1">
              <CommandDialogTrigger
                render={<SidebarMenuButton data-testid="command-palette-trigger" />}
              >
                <SearchIcon />
                <span className="flex-1 truncate">Search</span>
                {shortcutLabel ? <Kbd>{shortcutLabel}</Kbd> : null}
              </CommandDialogTrigger>
            </div>
            <LastCodeSidebarThreadPicker projectGroups={projects} />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
});
