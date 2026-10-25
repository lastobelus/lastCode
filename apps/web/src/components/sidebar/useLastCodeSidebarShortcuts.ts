import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../../types";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useSidebar } from "../ui/sidebar";
import {
  useThreadJumpHintVisibility,
  shouldClearThreadSelectionOnMouseDown,
} from "../Sidebar.logic";
import { useLastCodeNavigateToThread } from "./useLastCodeThreadNavigation";
import {
  EMPTY_LASTCODE_THREAD_JUMP_LABELS,
  lastCodeThreadJumpCommands,
  lastCodeThreadJumpLabels,
  resolveLastCodeSidebarShortcutTarget,
} from "./lastcodeSidebarNavigation";
import type { useLastCodeSidebarRoute } from "./useLastCodeSidebarRoute";
function useKeyboardNavigation(
  keys: readonly string[],
  threads: ReadonlyMap<string, SidebarThreadSummary>,
  route: ReturnType<typeof useLastCodeSidebarRoute>,
  keybindings: ResolvedKeybindingsConfig,
) {
  const navigateToThread = useLastCodeNavigateToThread(useRouter());
  const platform = navigator.platform;
  const { routeThreadKey, routeTerminalOpen } = route;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const context = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      };
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (isCommandPaletteOpen()) return;
      if (isModelPickerOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, { platform, context });
      const target = resolveLastCodeSidebarShortcutTarget(command, keys, routeThreadKey, threads);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void navigateToThread(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keys, threads, routeThreadKey, routeTerminalOpen, keybindings, platform, navigateToThread]);
}
function useSelectionDismissal() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (shouldClearThreadSelectionOnMouseDown(target)) clearSelection();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [clearSelection]);
}
/** Root shortcut labels/hints and event registration; no row or operation state. */
export function useLastCodeSidebarShortcuts(
  keys: readonly string[],
  threads: ReadonlyMap<string, SidebarThreadSummary>,
  route: ReturnType<typeof useLastCodeSidebarRoute>,
) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom),
    platform = navigator.platform;
  const { isMobile } = useSidebar();
  const terminalFocus = useTerminalFocus(),
    modifiers = useShortcutModifierState();
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const commands = lastCodeThreadJumpCommands(keys);
  const { routeTerminalOpen } = route;
  const labels = lastCodeThreadJumpLabels(commands, keybindings, routeTerminalOpen, platform);
  const shouldShow = shouldShowThreadJumpHintsForModifiers(modifiers, keybindings, {
    platform,
    context: {
      terminalFocus,
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    },
  });
  useEffect(
    () => updateThreadJumpHintsVisibility(shouldShow),
    [shouldShow, updateThreadJumpHintsVisibility],
  );
  useKeyboardNavigation(keys, threads, route, keybindings);
  useSelectionDismissal();
  const options = { platform, context: { terminalFocus: false, terminalOpen: false } };
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", options) ??
    shortcutLabelForCommand(keybindings, "chat.new", options);
  const commandPaletteShortcutLabel = isMobile
    ? null
    : shortcutLabelForCommand(keybindings, "commandPalette.toggle", options);
  return {
    visibleThreadJumpLabelByKey: showThreadJumpHints ? labels : EMPTY_LASTCODE_THREAD_JUMP_LABELS,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
  };
}
