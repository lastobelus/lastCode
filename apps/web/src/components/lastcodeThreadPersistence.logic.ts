import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

export function lastcodeThreadPersistenceAction(input: {
  readonly persistent: boolean;
  readonly supported: boolean;
}): ContextMenuItem | null {
  if (!input.supported) return null;
  return {
    id: input.persistent ? "disable-persistence" : "mark-persistent",
    label: input.persistent
      ? m(msg("Disable persistent thread"))
      : m(msg("Mark as persistent thread")),
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
          label: m(msg("{label} (disable persistence first)", { label: item.label })),
          disabled: true,
        }
      : item,
  );
}
