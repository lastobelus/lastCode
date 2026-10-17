import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import {
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { resolveAdjacentThreadId } from "../Sidebar.logic";
export const EMPTY_LASTCODE_THREAD_JUMP_LABELS: ReadonlyMap<string, string> = new Map();
export function lastCodeThreadJumpCommands(keys: readonly string[]) {
  const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
  for (const [index, key] of keys.entries()) {
    const command = threadJumpCommandForIndex(index);
    if (!command) return mapping;
    mapping.set(key, command);
  }
  return mapping;
}
/** Resolve both shortcut kinds before performing one guarded navigation operation. */
export function resolveLastCodeSidebarShortcutTarget(
  command: string | null,
  orderedKeys: readonly string[],
  currentKey: string | null,
  threads: ReadonlyMap<string, SidebarThreadSummary>,
): ScopedThreadRef | null {
  const direction = threadTraversalDirectionFromCommand(command);
  const jumpIndex = threadJumpIndexFromCommand(command ?? "");
  const key =
    direction !== null
      ? resolveAdjacentThreadId({ threadIds: orderedKeys, currentThreadId: currentKey, direction })
      : jumpIndex === null
        ? null
        : orderedKeys[jumpIndex];
  const thread = key ? threads.get(key) : null;
  return thread ? scopeThreadRef(thread.environmentId, thread.id) : null;
}
export function lastCodeThreadJumpLabels(
  commands: ReturnType<typeof lastCodeThreadJumpCommands>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
  platform: string,
) {
  const mapping = new Map<string, string>();
  for (const [key, command] of commands) {
    const label = shortcutLabelForCommand(keybindings, command, {
      platform,
      context: { terminalFocus: false, terminalOpen },
    });
    if (label) mapping.set(key, label);
  }
  return mapping.size > 0 ? mapping : EMPTY_LASTCODE_THREAD_JUMP_LABELS;
}
