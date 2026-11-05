import {
  isMacPlatform,
  resolveEventKeys,
  type ShortcutEventLike,
} from "@t3tools/shared/keybindings";

/** Focused rich-text composers claim these source edits before app shortcuts. */
export function composerFormattingDelimiterForShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): "**" | "*" | "`" | "~~" | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  const mod = isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  const keys = resolveEventKeys(event);
  if (event.shiftKey) return keys.has("s") ? "~~" : null;
  if (keys.has("b")) return "**";
  if (keys.has("i")) return "*";
  if (keys.has("e")) return "`";
  return null;
}
