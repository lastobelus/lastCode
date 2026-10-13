import type { MenuAction } from "@react-native-menu/menu";

/** Android renders UIKit-style inline groups as direct commands with dividers. */
export function flattenInlineMenuGroups(
  actions: ReadonlyArray<MenuAction>,
): Array<{ action: MenuAction; separatorBefore: boolean }> {
  const rows: Array<{ action: MenuAction; separatorBefore: boolean }> = [];
  let afterGroup = false;
  for (const action of actions) {
    if (action.attributes?.hidden) continue;
    if (action.displayInline && action.subactions) {
      const group = flattenInlineMenuGroups(action.subactions);
      if (group.length === 0) continue;
      group[0]!.separatorBefore = rows.length > 0;
      rows.push(...group);
      afterGroup = true;
    } else {
      rows.push({ action, separatorBefore: afterGroup });
      afterGroup = false;
    }
  }
  return rows;
}
