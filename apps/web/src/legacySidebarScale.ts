import type { CSSProperties } from "react";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";

type LegacySidebarScaleStyle = CSSProperties & {
  "--legacy-sidebar-content-zoom": number;
};

/**
 * Scale the legacy project tree while preserving its layout and scroll bounds.
 * CSS zoom participates in layout, so no inverse dimensions are needed. Selected
 * content uses the reciprocal factor inside this surface to retain its stock size.
 * Electron's window zoom is applied outside this element and composes with
 * both factors.
 */
export function legacySidebarScaleStyle(scale: LegacySidebarScale): LegacySidebarScaleStyle {
  const ratio = scale / 100;
  return {
    zoom: ratio,
    "--legacy-sidebar-content-zoom": 1 / ratio,
  };
}
