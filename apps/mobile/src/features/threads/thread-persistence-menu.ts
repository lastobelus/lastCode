import type { MenuAction } from "@react-native-menu/menu";

export function persistenceIntentForMenuEvent(event: string): boolean | null {
  if (event === "mark-persistent") return true;
  if (event === "disable-persistence") return false;
  return null;
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
