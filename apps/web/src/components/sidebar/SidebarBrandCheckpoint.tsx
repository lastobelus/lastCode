import { parseLastCodeVersion } from "@t3tools/shared/lastcodeVersionLabel";
import { useGT } from "gt-react";

import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSetting, useSidebarMode } from "../../hooks/useSettings";
import { lastcodeSidebarScaleStyle } from "../../lastcodeSidebarScale";
import { cn } from "../../lib/utils";
import { InlineButton } from "../ui/button";
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
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-5 flex justify-center text-sm leading-none",
        onBackdrop && "[--color-foreground:white]",
      )}
    >
      <InlineButton
        aria-label={gt("Copy {label}", { label })}
        className="pointer-events-auto [-webkit-app-region:no-drag]"
        style={lastcodeSidebarScaleStyle(sidebarMode === "lastcode" ? scale : 100)}
        onClick={() => copyToClipboard(label, undefined)}
      >
        {build.checkpoint}
      </InlineButton>
    </div>
  );
}
