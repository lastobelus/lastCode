import type { KeyboardEvent } from "react";

/** Nested controls keep their native keyboard action; only the row activates navigation. */
export function activateSidebarRowFromKeyboard(
  event: KeyboardEvent<Element>,
  activate: () => void,
) {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }
  event.preventDefault();
  activate();
}
