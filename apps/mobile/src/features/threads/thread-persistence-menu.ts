import type { MenuAction } from "@react-native-menu/menu";

export function persistenceIntentForMenuEvent(event: string): boolean | null {
  if (event === "mark-persistent") return true;
  if (event === "disable-persistence") return false;
  return null;
}

/** Inline native groups place dividers without turning commands into submenus. */
export function withThreadMenuDividers(
  actions: ReadonlyArray<MenuAction>,
  supportsInlineGroups: boolean,
): MenuAction[] {
  if (!supportsInlineGroups) return [...actions];
  const groups: MenuAction[][] = [];
  let current: MenuAction[] = [];
  actions.forEach((action, index) => {
    current.push(action);
    const endsGroup =
      action.id === "new-thread-on-branch" ||
      action.id === "annotate" ||
      action.id === "stop-thread-processes" ||
      ((action.id === "mark-persistent" || action.id === "disable-persistence") &&
        actions[index + 1]?.id !== "stop-thread-processes");
    if (endsGroup) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length > 0) groups.push(current);
  if (groups.length < 2) return [...actions];
  return groups.map((subactions, index) => ({
    id: `thread-menu-group-${index}`,
    title: "",
    displayInline: true,
    subactions,
  }));
}

export function buildThreadPersistenceMenuItems(input: {
  readonly actions: ReadonlyArray<MenuAction>;
  readonly persistent: boolean;
  readonly supported: boolean;
}): MenuAction[] {
  const protectedActions = input.actions.map((action) =>
    input.persistent && (action.id === "archive" || action.id === "delete")
      ? {
          ...action,
          title: `${action.title} (disable persistence first)`,
          attributes: { ...action.attributes, disabled: true },
        }
      : action,
  );
  if (!input.supported) return protectedActions;
  return [
    {
      id: input.persistent ? "disable-persistence" : "mark-persistent",
      title: input.persistent ? "Disable persistent thread" : "Mark as persistent thread",
      image: "lock",
    },
    ...protectedActions,
  ];
}
