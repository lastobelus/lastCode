import type { CSSProperties } from "react";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";

/**
 * Scale the legacy project tree while preserving its layout and scroll bounds.
 * CSS zoom participates in layout, so no inverse dimensions are needed.
 * Electron's window zoom is applied outside this element and composes with
 * this factor.
 */
export function legacySidebarScaleStyle(scale: LegacySidebarScale): CSSProperties {
  const ratio = scale / 100;
  return {
    zoom: ratio,
  };
}
