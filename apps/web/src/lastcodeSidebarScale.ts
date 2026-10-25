import type { CSSProperties } from "react";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";

type LastCodeSidebarScaleStyle = CSSProperties & {
  "--lastcode-sidebar-content-zoom": number;
};

/**
 * CSS zoom preserves layout and scroll bounds without inverse dimensions.
 * Reciprocal content zoom retains stock sizing; Electron window zoom composes outside both.
 */
export function lastcodeSidebarScaleStyle(scale: LegacySidebarScale): LastCodeSidebarScaleStyle {
  const ratio = scale / 100;
  return {
    zoom: ratio,
    "--lastcode-sidebar-content-zoom": 1 / ratio,
  };
}
