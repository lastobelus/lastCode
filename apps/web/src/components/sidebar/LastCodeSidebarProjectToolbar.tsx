import { T, useGT } from "gt-react";
import { FolderPlusIcon } from "lucide-react";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LastCodeSidebarOptions } from "./LastCodeSidebarOptions";

export function LastCodeSidebarProjectToolbar() {
  const gt = useGT();
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  return (
    <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
      <span className="text-xs font-medium text-sidebar-muted-foreground/80">
        <T>Projects</T>
      </span>
      <div className="flex items-center gap-1">
        <LastCodeSidebarOptions />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Add project")}
                data-testid="sidebar-add-project-trigger"
                onClick={openAddProject}
              />
            }
          >
            <FolderPlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">
            <T>Add project</T>
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
