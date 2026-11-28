import { parseLastCodeVersion } from "@t3tools/shared/lastcodeVersionLabel";
import { useGT } from "gt-react";

import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSetting, useSidebarMode } from "../../hooks/useSettings";
import { lastcodeSidebarScaleStyle } from "../../lastcodeSidebarScale";
import { cn } from "../../lib/utils";
import { toastManager } from "../ui/toast";

export function SidebarBrandCheckpoint({ onBackdrop }: { onBackdrop: boolean }) {
  const gt = useGT();
  const sidebarMode = useSidebarMode();
  const scale = useClientSetting("legacySidebarScale");
  const { copyToClipboard } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({ type: "error", title: gt("Could not copy"), description: error.message });
    },
  });
  const build = parseLastCodeVersion(APP_VERSION);
  if (build === null) return null;
  const label = `checkpoint ${build.checkpoint}`;

  return (
    <div className="pointer-events-none relative -mt-0.5 flex h-3.5 justify-center text-sm leading-none">
      <button
        type="button"
        aria-label={gt("Copy {label}", { label })}
        className={cn(
          "pointer-events-auto cursor-pointer self-start font-normal underline-offset-2 hover:underline focus-visible:outline-2 -outline-offset-2 focus-visible:outline-ring [-webkit-app-region:no-drag]",
          onBackdrop ? "text-white/70" : "text-sidebar-muted-foreground/80",
        )}
        style={lastcodeSidebarScaleStyle(sidebarMode === "lastcode" ? scale : 100)}
        onClick={() => copyToClipboard(label, undefined)}
      >
        {build.checkpoint}
      </button>
    </div>
  );
}
