import type { CSSProperties } from "react";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";

type LegacySidebarScaleStyle = CSSProperties & {
  "--legacy-sidebar-icon-zoom": number;
};

/**
 * Scale the legacy project tree while preserving its layout and scroll bounds.
 * CSS zoom participates in layout, so no inverse dimensions are needed. Icons
 * use the reciprocal factor inside this surface to retain their stock size.
 * Electron's window zoom is applied outside this element and composes with
 * both factors.
 */
export function legacySidebarScaleStyle(scale: LegacySidebarScale): LegacySidebarScaleStyle {
  const ratio = scale / 100;
  return {
    zoom: ratio,
    "--legacy-sidebar-icon-zoom": 1 / ratio,
  };
}
