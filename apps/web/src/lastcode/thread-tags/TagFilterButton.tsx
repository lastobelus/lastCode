import { TagIcon } from "lucide-react";
import { useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { TagPicker } from "./TagPicker";
import { useTagEnvironmentIds, useTagFilterStore } from "./state";

export function TagFilterButton({ onBackdrop = false }: { readonly onBackdrop?: boolean }) {
  const enabled = useClientSettings((settings) => settings.lastcodeThreadTagsSidebarEnabled);
  return enabled ? <TagFilterControl onBackdrop={onBackdrop} /> : null;
}

function TagFilterControl({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const environmentIds = useTagEnvironmentIds();
  const archived = useTagFilterStore((state) => state.archived);
  const select = useTagFilterStore((state) => state.select);
  const setArchived = useTagFilterStore((state) => state.setArchived);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            className="[-webkit-app-region:no-drag]"
            variant={onBackdrop ? "media-navigation" : "ghost"}
            size="icon-sm"
            aria-label="Filter threads by tag"
          />
        }
      >
        <TagIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        width="md"
        padding="none"
        align="start"
        animated={false}
        aria-label="Filter by tag"
      >
        <TagPicker
          key={archived ? "archive" : "active"}
          environmentIds={environmentIds}
          archived={archived}
          onSelect={(tag) => {
            select(tag);
            setOpen(false);
          }}
        />
        <label className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Archived only
          <Switch size="sm" checked={archived} onCheckedChange={setArchived} />
        </label>
      </PopoverPopup>
    </Popover>
  );
}
