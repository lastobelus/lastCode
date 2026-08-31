import type { ContextMenuItem } from "@t3tools/contracts";

export function legacyThreadPersistenceAction(input: {
  readonly persistent: boolean;
  readonly supported: boolean;
}): ContextMenuItem | null {
  if (!input.supported) return null;
  return {
    id: input.persistent ? "disable-persistence" : "mark-persistent",
    label: input.persistent ? "Disable persistent thread" : "Mark as persistent thread",
    icon: "message-square-lock",
  };
}

export function protectLegacyThreadActions(
  items: ReadonlyArray<ContextMenuItem>,
  persistent: boolean,
): ContextMenuItem[] {
  if (!persistent) return [...items];
  return items.map((item) =>
    item.id === "archive" || item.id === "delete"
      ? {
          ...item,
          label: `${item.label} (disable persistence first)`,
          disabled: true,
        }
      : item,
  );
}
