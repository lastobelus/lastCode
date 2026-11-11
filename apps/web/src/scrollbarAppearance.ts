import type { ScrollbarMargin, ScrollbarWidth } from "@t3tools/contracts/settings";

export function applyScrollbarAppearance(
  root: HTMLElement,
  options: {
    enabled: boolean;
    width: ScrollbarWidth;
    margin: ScrollbarMargin;
  },
): void {
  root.toggleAttribute("data-larger-scrollbars", options.enabled);

  if (!options.enabled) {
    root.style.removeProperty("--app-scrollbar-width");
    root.style.removeProperty("--app-scrollbar-margin");
    root.style.removeProperty("--app-scrollbar-lane-width");
    root.style.removeProperty("--app-native-scrollbar-margin");
    root.style.removeProperty("--app-native-scrollbar-width");
    root.style.removeProperty("--app-compact-scrollbar-height");
    root.style.removeProperty("--app-code-scrollbar-height");
    root.style.removeProperty("--app-scrollbar-thumb-inset");
    return;
  }

  root.style.setProperty("--app-scrollbar-width", `${options.width}px`);
  root.style.setProperty("--app-scrollbar-margin", `${options.margin}px`);
  root.style.setProperty("--app-scrollbar-lane-width", `${options.width + options.margin}px`);
  root.style.setProperty("--app-native-scrollbar-margin", `${options.margin}px`);
  root.style.setProperty("--app-native-scrollbar-width", "auto");
  root.style.setProperty("--app-compact-scrollbar-height", `${options.width + options.margin}px`);
  root.style.setProperty("--app-code-scrollbar-height", `${options.width + options.margin}px`);
  root.style.setProperty("--app-scrollbar-thumb-inset", "0px");
}
